import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls } from "@/lib/db/schema-okk";
import { eq } from "drizzle-orm";

// UUID validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  try {
    const { callId } = await params;
    const dept = (request.nextUrl.searchParams.get("dept") ?? "b2g") as
      | "b2g"
      | "b2b";

    if (!UUID_RE.test(callId)) {
      return NextResponse.json({ error: "Invalid call ID" }, { status: 400 });
    }

    // Look up recording_url from the OKK database
    const db = getOkkDbForDepartment(dept);
    const [callRow] = await db
      .select({ recordingUrl: okkCalls.recordingUrl })
      .from(okkCalls)
      .where(eq(okkCalls.id, callId))
      .limit(1);

    if (!callRow) {
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }

    const recordingUrl = callRow.recordingUrl;
    if (!recordingUrl) {
      return NextResponse.json(
        { error: "No recording available for this call" },
        { status: 404 }
      );
    }

    // Proxy the audio from the remote URL (avoids CORS on the client)
    // Forward Range header for seek support in <audio> elements
    const fetchHeaders: Record<string, string> = { Accept: "audio/mpeg, audio/ogg, audio/webm, audio/*" };
    const rangeHeader = request.headers.get("Range");
    if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

    const upstream = await fetch(recordingUrl, { headers: fetchHeaders });

    if (!upstream.ok) {
      if (upstream.status === 404) {
        return NextResponse.json(
          { error: "Recording file not found at storage" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Failed to fetch recording" },
        { status: upstream.status }
      );
    }

    const contentType =
      upstream.headers.get("content-type") ?? "audio/mpeg";
    const contentLength = upstream.headers.get("content-length");

    // Stream-proxy: avoid loading the entire file into memory
    if (upstream.body) {
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      };
      if (contentLength) {
        headers["Content-Length"] = contentLength;
      }
      const contentRange = upstream.headers.get("Content-Range");
      if (contentRange) headers["Content-Range"] = contentRange;

      return new NextResponse(upstream.body, { status: upstream.status, headers });
    }

    // Fallback: buffer the whole file (should rarely be reached)
    const audioData = await upstream.arrayBuffer();
    return new NextResponse(audioData, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(audioData.byteLength),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[OKK Audio] Error proxying audio:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
