# Docker Setup Guide

Last reviewed: 2026-05-21.

> Production runs on **Dokploy** (Docker Compose orchestrator + Traefik for TLS). The production `docker-compose.yml` declares three services: `app` (Next.js, port 3008), `mcp` (MCP server, port 3009), `etl-cron` (curl-loop that pings `/api/analytics/sync/cron` every ~10 min). The env-var whitelist inside that file is load-bearing — adding a var to Dokploy UI alone does NOT pipe it into the container.

## Prerequisites

- Docker Desktop installed (includes Docker Compose)
- `.env.local` file with required environment variables (template in `.env.example`)
- For local dev with hot reload you usually skip Docker entirely and run `npm run dev` against remote Neon DBs.

## Quick Start

### Production Mode (with Neon Database)

1. **Build and start the application:**
```bash
docker-compose up --build
```

2. **Access the application:**
- Dashboard: http://localhost:3008

3. **Stop the application:**
```bash
docker-compose down
```

### Development Mode (with local PostgreSQL)

1. **Start local PostgreSQL and app:**
```bash
docker-compose -f docker-compose.dev.yml up --build
```

2. **Run migrations (in another terminal):**
```bash
# Install dependencies locally if not already done
npm install

# Run Drizzle migrations
npm run db:push
```

3. **Access services:**
- Dashboard: http://localhost:3008
- PostgreSQL: localhost:5432
  - Database: `sternmeister_dev`
  - User: `postgres`
  - Password: `postgres`

4. **Stop services:**
```bash
docker-compose -f docker-compose.dev.yml down
```

## Environment Variables

The full var set has grown well past what's listed here. See [`CLAUDE.md`](./CLAUDE.md#6-environment-variables) for the canonical list (6 Neon DBs, Kommo, telephony, Telegram, AI, MCP). The `.env.example` template covers the minimum required.

```env
# Bare minimum to boot the app:
DATABASE_URL=postgresql://...          # D1 (B2G roleplay + master_managers)
R1_DATABASE_URL=...                    # B2B roleplay (auto-derived if blank)
D2_OKK_DATABASE_URL=...                # B2G OKK
R2_OKK_DATABASE_URL=...                # B2B OKK
ANALYTICS_DATABASE_URL=...             # analytics.* mirror
TRACKING_DATABASE_URL=...              # tracking_events
SESSION_SECRET=...                     # required in production
KOMMO_ACCESS_TOKEN=...
TZ=Europe/Berlin
APP_TIMEZONE=Europe/Berlin
```

## Docker Commands Reference

### Build Docker Image
```bash
docker build -t sternmeister-dashboard .
```

### Run Container Manually
```bash
docker run -p 3000:3008 --env-file .env.local sternmeister-dashboard
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f app
```

### Clean Up

```bash
# Stop and remove containers, networks
docker-compose down

# Remove volumes as well (WARNING: deletes database data)
docker-compose down -v

# Remove images
docker-compose down --rmi all
```

### Development with Hot Reload

For development with hot reload, it's recommended to run the app locally:

```bash
npm run dev
```

And use Docker Compose only for the database:

```bash
docker-compose -f docker-compose.dev.yml up postgres
```

## Troubleshooting

### Port Already in Use
If port 3008 is already in use:
```bash
# Find process using port 3008
lsof -ti:3008

# Kill the process
kill -9 <PID>
```

Or change the port in `docker-compose.yml`:
```yaml
ports:
  - "3001:3008"  # Map to different host port
```

### Database Connection Issues
- Ensure `.env.local` has correct `DATABASE_URL`
- For local PostgreSQL, wait for healthcheck to pass
- Check logs: `docker-compose logs postgres`

### Build Fails
```bash
# Clean build cache
docker-compose build --no-cache

# Or rebuild from scratch
docker system prune -a
docker-compose up --build
```

## Architecture

The Docker setup includes:

- **Multi-stage build** for optimized image size
- **Non-root user** for security
- **Standalone output** for faster cold starts
- **Health checks** for database readiness
- **Volume mounting** for development hot reload

## Production Deployment

We deploy via **Dokploy** (self-hosted Docker Compose orchestrator) with Traefik for TLS termination. There is no manual `docker push` step — Dokploy clones the repo, runs `docker-compose up --build` on the configured server, and Traefik routes TLS by host header.

Production hosts:

- `dashboard.sternmeister.online` → `app` service (port 3008)
- `mcp.sternmeister.online` → `mcp` service (port 3009), see [`mcp-server/README.md`](./mcp-server/README.md)

Env vars live in the Dokploy UI but **must also be listed in the `environment:` whitelist of `docker-compose.yml`** to be visible inside the container. This has bitten us multiple times — always update both.

## Notes

- The production `docker-compose.yml` uses Neon PostgreSQL (serverless)
- Local development setup includes PostgreSQL container
- Adjust memory limits if running on resource-constrained environments
- Consider using Docker secrets for sensitive environment variables in production
