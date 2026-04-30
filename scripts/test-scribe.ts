/**
 * Local pilot test for ElevenLabs Scribe v2 batch transcription.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... npx tsx scripts/test-scribe.ts <audio-url>
 *
 * Optional second arg `--compare` runs the same URL through AssemblyAI too
 * (requires ASSEMBLYAI_API_KEY) so you can eyeball the diff before the
 * pipeline migration goes live.
 *
 * Prints:
 *   - raw text
 *   - speaker-block formatted output (the format pipeline.ts saves)
 *   - duration, language detected, word count
 */

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";

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
    const speaker = w.speaker_id ?? current?.speaker ?? "speaker_0";
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

async function transcribeWithScribe(audioUrl: string): Promise<{
  raw: ScribeResponse;
  speakers: string;
  elapsedMs: number;
} | null> {
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
    console.error(`Scribe ${res.status}: ${errText.slice(0, 500)}`);
    return null;
  }
  const raw = (await res.json()) as ScribeResponse;
  const speakers = formatSpeakerBlocks(raw.words);
  return { raw, speakers, elapsedMs };
}

async function transcribeWithAssemblyAI(audioUrl: string): Promise<{
  text: string;
  speakers: string;
  elapsedMs: number;
} | null> {
  const t0 = Date.now();
  const submit = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { Authorization: ASSEMBLYAI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, language_code: "ru", speaker_labels: true }),
  });
  const { id, error } = (await submit.json()) as { id?: string; error?: string };
  if (error || !id) {
    console.error("AssemblyAI submit error:", error);
    return null;
  }

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: ASSEMBLYAI_KEY },
    });
    const r = (await poll.json()) as {
      status: string;
      text?: string;
      utterances?: { speaker: string; text: string }[];
    };
    if (r.status === "completed") {
      const speakers =
        r.utterances?.map((u) => `**Speaker ${u.speaker}:** ${u.text}`).join("\n\n") ||
        r.text ||
        "";
      return { text: r.text || "", speakers, elapsedMs: Date.now() - t0 };
    }
    if (r.status === "error") return null;
  }
  return null;
}

async function main() {
  const url = process.argv[2];
  const compare = process.argv.includes("--compare");

  if (!url) {
    console.error("Usage: tsx scripts/test-scribe.ts <audio-url> [--compare]");
    process.exit(1);
  }
  if (!ELEVENLABS_KEY) {
    console.error("ELEVENLABS_API_KEY env var is required");
    process.exit(1);
  }
  if (compare && !ASSEMBLYAI_KEY) {
    console.error("--compare requires ASSEMBLYAI_API_KEY env var");
    process.exit(1);
  }

  console.log(`URL: ${url}`);
  console.log(`Compare mode: ${compare}`);
  console.log("");
  console.log("=== Scribe v2 ===");
  const scribe = await transcribeWithScribe(url);
  if (!scribe) {
    console.error("Scribe failed");
    process.exit(1);
  }
  console.log(`Elapsed: ${(scribe.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Audio duration: ${scribe.raw.audio_duration_secs?.toFixed(1)}s`);
  console.log(
    `Detected language: ${scribe.raw.language_code} (p=${scribe.raw.language_probability?.toFixed(3)})`,
  );
  console.log(`Words: ${scribe.raw.words?.length ?? 0}`);
  const uniqueSpeakers = new Set(scribe.raw.words?.map((w) => w.speaker_id).filter(Boolean) ?? []);
  console.log(`Unique speakers: ${uniqueSpeakers.size} (${[...uniqueSpeakers].join(", ")})`);
  console.log("");
  console.log("--- Raw text (first 500 chars) ---");
  console.log(scribe.raw.text.slice(0, 500));
  console.log("");
  console.log("--- Speaker blocks (first 1500 chars) ---");
  console.log(scribe.speakers.slice(0, 1500));
  console.log("");

  if (compare) {
    console.log("=== AssemblyAI ===");
    const aai = await transcribeWithAssemblyAI(url);
    if (!aai) {
      console.error("AssemblyAI failed");
    } else {
      console.log(`Elapsed: ${(aai.elapsedMs / 1000).toFixed(1)}s`);
      console.log("");
      console.log("--- Raw text (first 500 chars) ---");
      console.log(aai.text.slice(0, 500));
      console.log("");
      console.log("--- Speaker blocks (first 1500 chars) ---");
      console.log(aai.speakers.slice(0, 1500));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
