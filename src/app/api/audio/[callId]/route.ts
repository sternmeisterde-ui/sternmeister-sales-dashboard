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

    const contentType = response.headers.get("content-type") || "audio/webm";
    const contentLength = response.headers.get("content-length");

    // Стрим прокси — не загружаем весь файл в память
    // Это критично для больших записей (15-20 МБ)
    if (response.body) {
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      };
      if (contentLength) {
        headers["Content-Length"] = contentLength;
      }

      return new NextResponse(response.body, {
        status: 200,
        headers,
      });
    }

    // Fallback: если body не доступен как ReadableStream — загружаем целиком
    const audioData = await response.arrayBuffer();
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
