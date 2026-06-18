/**
 * Local smoke test for ElevenLabs Scribe v2 batch transcription.
 *
 * Mirrors the request shape used by `src/lib/analysis/pipeline.ts:tryTranscribe`
 * so the output here is what the production pipeline will see. Useful for
 * eyeballing diarization quality on a known recording without booting the
 * whole analysis run.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... npx tsx scripts/test-scribe.ts <audio-url>
 *
 * Prints:
 *   - elapsed time, audio duration, detected language
 *   - word count, unique speaker count
 *   - raw text (first 500 chars)
 *   - speaker-block formatted output (the format pipeline.ts saves)
 */

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
}
interface ScribeResponse {
  text: string;
  words?: ScribeWord[];
  language_code?: string;
  language_probability?: number;
  audio_duration_secs?: number;
}

function formatSpeakerBlocks(words: ScribeWord[] | undefined): string {
  if (!words || words.length === 0) return "";
  const blocks: { speaker: string; text: string }[] = [];
  let current: { speaker: string; text: string } | null = null;
  for (const w of words) {
    if (w.type === "audio_event") continue;
    const speaker: string = w.speaker_id ?? current?.speaker ?? "speaker_0";
    if (!current || current.speaker !== speaker) {
      if (current) blocks.push(current);
      current = { speaker, text: "" };
    }
    current.text += w.text;
  }
  if (current) blocks.push(current);

  const speakerMap = new Map<string, string>();
  let nextLetter = 0;
  return blocks
    .map((b) => {
      let label = speakerMap.get(b.speaker);
      if (!label) {
        label = String.fromCharCode(65 + nextLetter++);
        speakerMap.set(b.speaker, label);
      }
      return `**Speaker ${label}:** ${b.text.trim()}`;
    })
    .filter((s) => s.length > "**Speaker A:** ".length)
    .join("\n\n");
}

async function transcribe(audioUrl: string): Promise<{
  raw: ScribeResponse;
  speakers: string;
  elapsedMs: number;
}> {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("cloud_storage_url", audioUrl);
  form.append("language_code", "rus");
  form.append("diarize", "true");
  form.append("no_verbatim", "true");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "word");

  const t0 = Date.now();
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_KEY },
    body: form,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Scribe ${res.status}: ${errText.slice(0, 500)}`);
  }
  const raw = (await res.json()) as ScribeResponse;
  return { raw, speakers: formatSpeakerBlocks(raw.words), elapsedMs };
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx scripts/test-scribe.ts <audio-url>");
    process.exit(1);
  }
  if (!ELEVENLABS_KEY) {
    console.error("ELEVENLABS_API_KEY env var is required");
    process.exit(1);
  }

  console.log(`URL: ${url}\n`);
  const { raw, speakers, elapsedMs } = await transcribe(url);

  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Audio duration: ${raw.audio_duration_secs?.toFixed(1)}s`);
  console.log(
    `Detected language: ${raw.language_code} (p=${raw.language_probability?.toFixed(3)})`,
  );
  console.log(`Words: ${raw.words?.length ?? 0}`);
  const uniqueSpeakers = new Set(
    raw.words?.map((w) => w.speaker_id).filter(Boolean) ?? [],
  );
  console.log(`Unique speakers: ${uniqueSpeakers.size} (${[...uniqueSpeakers].join(", ")})\n`);

  console.log("--- Raw text (first 500 chars) ---");
  console.log(raw.text.slice(0, 500));
  console.log("");
  console.log("--- Speaker blocks (first 1500 chars) ---");
  console.log(speakers.slice(0, 1500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
