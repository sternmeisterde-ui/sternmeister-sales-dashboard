import { NextRequest, NextResponse } from "next/server";

// Маппинг отделов на API серверы
// b2g (Госники) → D1 сервер, b2b (Коммерсы) → R1 сервер
function getApiBaseUrl(dept: string): string {
  if (dept === "b2g") {
    return process.env.D1_API_URL || "https://roleplay2.sternmeister.online";
  }
  return process.env.R1_API_URL || "https://roleplay1.sternmeister.online";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  try {
    const { callId } = await params;
    const dept = request.nextUrl.searchParams.get("dept") || "b2g";

    // Валидация UUID формата
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(callId)) {
      return NextResponse.json({ error: "Invalid call ID" }, { status: 400 });
    }

    const baseUrl = getApiBaseUrl(dept);
    const audioUrl = `${baseUrl}/api/recording/${callId}`;

    // Проксируем запрос к API серверу (серверный запрос — без CORS ограничений)
    const response = await fetch(audioUrl, {
      headers: {
        Accept: "audio/webm, audio/*",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: "Recording not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Failed to fetch recording" },
        { status: response.status }
      );
    }

    // Стримим аудио обратно клиенту
    const audioData = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/webm";

    return new NextResponse(audioData, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": audioData.byteLength.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error proxying audio:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
