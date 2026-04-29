#!/usr/bin/env python3
"""
One-time backfill: mirror integrator's pre-computed SLA + TLT values
into our analytics.sla integrator-snapshot columns.

Sources (45.156.25.84/db, read-only access expiring soon):
  sternmeister_sla.sla_first_call_seconds              → sla_first_call_seconds_integrator
  sternmeister_sla.sla_first_call_calendar_seconds     → sla_first_call_calendar_seconds_integrator
  sternmeister_sla.business_hours_since_last_contact   → tlt_integrator
                                                          (their TLT == bh_since_last_contact - 3640s offset;
                                                           we mirror the source bh-since field directly which
                                                           is what their Looker actually displays)

Run once:
  python3 scripts/backfill-integrator-snapshot.py

Idempotent: re-running just overwrites with same values.
"""

import os
import sys
import pymysql
import ssl
from urllib.parse import urlparse

# Reuse Neon HTTP via psycopg if available, else fall back to manual.
try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("psycopg2 not installed — `pip3 install psycopg2-binary`", file=sys.stderr)
    sys.exit(1)


def main():
    # Read Neon URL from .env.local
    neon_url = None
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    with open(env_path) as f:
        for line in f:
            if line.startswith("ANALYTICS_DATABASE_URL="):
                neon_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not neon_url:
        print("ANALYTICS_DATABASE_URL missing in .env.local", file=sys.stderr)
        sys.exit(1)

    # Neon HTTP→psycopg compat: psycopg expects standard postgres URL
    parsed = urlparse(neon_url.replace("postgresql+http://", "postgresql://"))
    pg_dsn = neon_url.replace("postgresql+http://", "postgresql://")

    print("[backfill] connecting to integrator MySQL (45.156.25.84)…")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    mysql = pymysql.connect(
        host="45.156.25.84",
        port=3306,
        user="sternmeister",
        password="vFltZ4Y1fCmdEnPwVcZsIdnX",
        database="db",
        ssl=ctx,
        connect_timeout=15,
        cursorclass=pymysql.cursors.DictCursor,
    )

    print("[backfill] connecting to Neon (analytics)…")
    pg = psycopg2.connect(pg_dsn, sslmode="require")

    try:
        with mysql.cursor() as mc:
            mc.execute("""
              SELECT lead_id,
                     sla_first_call_seconds,
                     sla_first_call_calendar_seconds,
                     business_hours_since_last_contact
              FROM sternmeister_sla
              WHERE lead_id IS NOT NULL
            """)
            rows = mc.fetchall()
        print(f"[backfill] integrator rows: {len(rows)}")

        # Stage values into a temp VALUES expression — small batches keep
        # PG's expression-tree shallow.
        values = [
            (
                int(r["lead_id"]),
                None if r["sla_first_call_seconds"] is None else int(r["sla_first_call_seconds"]),
                None if r["sla_first_call_calendar_seconds"] is None else int(r["sla_first_call_calendar_seconds"]),
                None if r["business_hours_since_last_contact"] is None else int(r["business_hours_since_last_contact"]),
            )
            for r in rows
        ]

        BATCH = 1000
        updated = 0
        with pg.cursor() as pc:
            for i in range(0, len(values), BATCH):
                chunk = values[i : i + BATCH]
                # Use VALUES + UPDATE FROM pattern. Insert-or-update:
                # if our analytics.sla doesn't have a row for the lead
                # we won't create one — the integrator-snapshot is meant
                # to hydrate existing rows, not build out the table.
                execute_values(
                    pc,
                    """
                    UPDATE analytics.sla AS our SET
                      sla_first_call_seconds_integrator         = v.sla_first_call_seconds_integrator,
                      sla_first_call_calendar_seconds_integrator = v.sla_first_call_calendar_seconds_integrator,
                      tlt_integrator                             = v.tlt_integrator
                    FROM (VALUES %s) AS v(lead_id, sla_first_call_seconds_integrator,
                                          sla_first_call_calendar_seconds_integrator, tlt_integrator)
                    WHERE our.lead_id = v.lead_id
                    """,
                    chunk,
                    template="(%s::bigint, %s::bigint, %s::bigint, %s::bigint)",
                    page_size=BATCH,
                )
                updated += pc.rowcount
                print(f"  [backfill] processed {min(i + BATCH, len(values))}/{len(values)}  updated={updated}")
            pg.commit()

        # For leads that exist in integrator's sla but not in ours — log them.
        with pg.cursor() as pc:
            pc.execute("""
              SELECT COUNT(*) FROM analytics.sla
              WHERE sla_first_call_seconds_integrator IS NOT NULL
                 OR sla_first_call_calendar_seconds_integrator IS NOT NULL
                 OR tlt_integrator IS NOT NULL
            """)
            (have_integrator,) = pc.fetchone()
        print(f"[backfill] done. {have_integrator} our-rows now carry integrator snapshot")

    finally:
        mysql.close()
        pg.close()


if __name__ == "__main__":
    main()
