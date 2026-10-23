import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type SpeechWord = { start: number; end: number; word: string };
type SpeechSegment = { start: number; end: number; text: string; words?: SpeechWord[] };
export type RenderSource = { fileId?: string; url?: string; name: string };
export type CaptionStyle = "glass" | "pink" | "fuchsia" | "olive" | "echo" | "mixed";
export type RenderJob = { id: string; chatId: number; sources: RenderSource[]; style?: CaptionStyle };

type WorkerResponse = { ok?: boolean; error?: string; description?: string };

function workerUrl() {
  const value = process.env.REELBOT_GATEWAY_URL;
  if (!value) throw new Error("REELBOT_GATEWAY_URL is not configured");
  return value.replace(/\/$/, "");
}

function authHeaders(extra?: HeadersInit) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required for the private runner");
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function workerJson(path: string, body: unknown): Promise<WorkerResponse> {
  const response = await fetch(`${workerUrl()}${path}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  let payload: WorkerResponse = {};
  try { payload = (await response.json()) as WorkerResponse; } catch { /* handled below */ }
  if (!response.ok) throw new Error(payload.error || `Worker proxy returned HTTP ${response.status}`);
  return payload;
}

async function sendTelegramMessage(chatId: number, text: string) {
  await workerJson("/runner/message", { chatId, text });
}

async function downloadTelegramFile(fileId: string, dir: string, name: string) {
  const response = await fetch(`${workerUrl()}/runner/file`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ fileId }),
  });
  if (!response.ok || !response.body) {
    let reason = "Не удалось скачать видео через защищённый шлюз Telegram.";
    try { reason = ((await response.json()) as WorkerResponse).error || reason; } catch { /* no body */ }
    throw new Error(reason);
  }
  const safeName = basename(name || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const output = join(dir, `${Date.now()}-${safeName}`);
  await writeFile(output, new Uint8Array(await response.arrayBuffer()));
  return output;
}

async function downloadExternalFile(url: string, dir: string, name: string) {
  const normalized = url.includes("dropbox.com")
    ? url.replace(/[?&]dl=0\b/, "dl=1")
    : url.includes("1drv.ms") || url.includes("onedrive.live.com")
      ? `${url}${url.includes("?") ? "&" : "?"}download=1`
      : url;
  const response = await fetch(normalized, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error("Не удалось скачать исходник по ссылке Dropbox/OneDrive.");
  const safeName = basename(name || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const output = join(dir, `${Date.now()}-${safeName}`);
  const file = new Uint8Array(await response.arrayBuffer());
  if (file.byteLength > 2 * 1024 * 1024 * 1024) throw new Error("Файл больше 2 ГБ — для одного задания это слишком большой исходник.");
  await writeFile(output, file);
  return output;
}

async function sendTelegramVideo(chatId: number, filePath: string, caption: string) {
  const data = await readFile(filePath);
  if (data.byteLength > 49 * 1024 * 1024) throw new Error("Готовый ролик превышает лимит отправки Telegram 49 МБ.");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("video", new Blob([new Uint8Array(data)], { type: "video/mp4" }), basename(filePath));
  const response = await fetch(`${workerUrl()}/runner/video`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  let payload: WorkerResponse = {};
  try { payload = (await response.json()) as WorkerResponse; } catch { /* handled below */ }
  if (!response.ok) throw new Error(payload.error || "Telegram не принял готовое видео.");
}

function run(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} завершился с кодом ${code}: ${stderr.slice(-1000)}`)));
  });
}

function assTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function assText(text: string) {
  return text.replace(/[{}\\]/g, "").replace(/\n/g, "\\N").trim();
}

function captionText(text: string, style: CaptionStyle) {
  const safe = assText(text);
  if (style !== "mixed") return safe;
  const [first, ...rest] = safe.split(" ");
  return `{\\c&H00A3FF&}${first}{\\c&H00FFFFFF&}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

function cleanSpeechText(text: string) {
  return text
    .replace(/\b(э+|э-э|эм+|м-м|мм+|бэ)\b[\s,.-]*/giu, "")
    .replace(/(^|\s)(а|ну)(?=\s|[,!.?]|$)/giu, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function isFillerWord(word: SpeechWord) {
  const normalized = word.word.toLowerCase().replace(/[^а-яё-]/giu, "");
  const duration = word.end - word.start;
  if (duration > 0.8) return false;
  return ["э", "ээ", "э-э", "эм", "эмм", "м", "мм", "м-м", "бэ"].includes(normalized)
    || (["а", "ну"].includes(normalized) && duration <= 0.45);
}

function makeAss(segments: SpeechSegment[], style: CaptionStyle = "glass") {
  const styleRows: Record<CaptionStyle, string> = {
    glass: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00F2E8DD,&H9A202020,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
    pink: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00F8D9E8,&HAA6E3858,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
    fuchsia: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00FF4FA3,&HCC181018,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
    olive: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00C6D59A,&HAA2F3924,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
    echo: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00F2E8DD,&H8A202020,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
    mixed: "DejaVu Sans,62,&H00FFFFFF,&H00FFFFFF,&H00FF4FA3,&H9A202020,-1,0,0,0,100,100,0,0,3,10,2,2,90,90,500,1",
  };
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Reel,${styleRows[style].replace(",62,", ",54,").replace(",90,90,500,", ",150,150,500,")}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const events = segments.flatMap((segment) => {
    const words = (segment.words ?? []).filter((word) => !isFillerWord(word));
    if (!words.length) {
      const text = cleanSpeechText(segment.text);
      return text ? [`Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Reel,,0,0,0,,${assText(text)}`] : [];
    }
    const chunks: SpeechWord[][] = [];
    for (let index = 0; index < words.length; index += 3) chunks.push(words.slice(index, index + 3));
    return chunks.map((chunk) => {
      const text = cleanSpeechText(chunk.map((word) => word.word).join(" "));
      if (!text) return "";
      return `Dialogue: 0,${assTime(chunk[0].start)},${assTime(chunk[chunk.length - 1].end)},Reel,,0,0,0,,${captionText(text, style)}`;
    }).filter(Boolean);
  }).join("\n");
  return `${header}${events}\n`;
}

async function transcribe(videoPath: string): Promise<SpeechSegment[]> {
  const audioPath = `${videoPath}.m4a`;
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", audioPath]);
  const script = "import json, os, sys, whisper\nmodel = whisper.load_model(os.environ.get('WHISPER_MODEL', 'tiny'))\nresult = model.transcribe(sys.argv[1], language='ru', task='transcribe', fp16=False, word_timestamps=True, condition_on_previous_text=False)\nprint(json.dumps({'segments': result.get('segments', []), 'text': result.get('text', '')}, ensure_ascii=False))";
  const result = await run("python3", ["-c", script, audioPath]);
  const payload = JSON.parse(result.stdout) as { text?: string; segments?: SpeechSegment[] };
  if (payload.segments?.length) return payload.segments.map((item) => ({ start: item.start, end: item.end, text: cleanSpeechText(item.text), words: item.words }));
  return [{ start: 0, end: 9999, text: payload.text ?? "" }];
}

async function removeFillerWords(inputPath: string, segments: SpeechSegment[], dir: string) {
  const fillers = segments.flatMap((segment) => (segment.words ?? []).filter(isFillerWord));
  if (!fillers.length) return inputPath;
  const durationProbe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath]);
  const duration = Number(durationProbe.stdout.trim());
  if (!Number.isFinite(duration)) return inputPath;
  const intervals: Array<[number, number]> = [];
  let cursor = 0;
  for (const filler of fillers.sort((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, filler.start - 0.04);
    const end = Math.min(duration, filler.end + 0.04);
    if (start - cursor > 0.12) intervals.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (duration - cursor > 0.12) intervals.push([cursor, duration]);
  if (intervals.length < 2) return inputPath;
  const pieces: string[] = [];
  for (const [start, end] of intervals) {
    const piece = join(dir, `filler-cut-${pieces.length}.mp4`);
    await run("ffmpeg", ["-y", "-ss", String(start), "-i", inputPath, "-t", String(end - start), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", piece]);
    pieces.push(piece);
  }
  return concatSources(pieces, dir);
}

async function concatSources(paths: string[], dir: string) {
  if (paths.length === 1) return paths[0];
  const listPath = join(dir, "concat.txt");
  await writeFile(listPath, paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"));
  const output = join(dir, "joined.mp4");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output]);
  return output;
}

async function removeLongPauses(inputPath: string, dir: string) {
  let diagnostic = "";
  try {
    const result = await run("ffmpeg", ["-hide_banner", "-i", inputPath, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"]);
    diagnostic = result.stderr;
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : "";
  }
  const starts = [...diagnostic.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...diagnostic.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  if (!starts.length || !ends.length) return inputPath;
  const durationProbe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath]);
  const duration = Number(durationProbe.stdout.trim());
  if (!Number.isFinite(duration)) return inputPath;
  const intervals: Array<[number, number]> = [];
  let cursor = 0;
  starts.forEach((start, index) => {
    const end = ends[index] ?? start;
    const keepEnd = Math.max(cursor, start - 0.08);
    if (keepEnd - cursor > 0.15) intervals.push([cursor, keepEnd]);
    cursor = Math.min(duration, end + 0.08);
  });
  if (duration - cursor > 0.15) intervals.push([cursor, duration]);
  if (intervals.length < 2) return inputPath;
  const pieces: string[] = [];
  for (const [start, end] of intervals) {
    const piece = join(dir, `cut-${pieces.length}.mp4`);
    await run("ffmpeg", ["-y", "-ss", String(start), "-i", inputPath, "-t", String(end - start), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", piece]);
    pieces.push(piece);
  }
  return concatSources(pieces, dir);
}

async function renderVideo(inputPath: string, segments: SpeechSegment[], dir: string, style: CaptionStyle = "glass") {
  const assPath = join(dir, "captions.ass");
  await writeFile(assPath, makeAss(segments, style), "utf8");
  const output = join(dir, "reelbot-result.mp4");
  const vertical = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=1166:2074,crop=1080:1920";
  await run("ffmpeg", ["-y", "-i", inputPath, "-vf", `${vertical},subtitles=${assPath}`, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output]);
  return output;
}

async function compressForTelegram(path: string) {
  const current = await stat(path);
  if (current.size <= 45 * 1024 * 1024) return path;
  const compressed = `${path}.720.mp4`;
  await run("ffmpeg", ["-y", "-i", path, "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "1800k", "-maxrate", "2M", "-bufsize", "4M", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", compressed]);
  if ((await stat(compressed)).size > 49 * 1024 * 1024) throw new Error("После сжатия ролик всё ещё превышает лимит Telegram 49 МБ. Нужны более короткие исходники.");
  return compressed;
}

export async function processRenderJob(job: RenderJob) {
  if (!job?.id || !job.chatId || !Array.isArray(job.sources) || !job.sources.length) throw new Error("В задаче нет корректного списка исходных видео.");
  const dir = await mkdtemp(join(tmpdir(), "reelbot-"));
  try {
    await sendTelegramMessage(job.chatId, `Начинаю монтаж ${job.id}. Скачиваю ${job.sources.length} исходник(а), убираю паузы и слова-паразиты, затем собираю динамичные субтитры.`);
    const paths: string[] = [];
    for (const source of job.sources) {
      if (source.url) paths.push(await downloadExternalFile(source.url, dir, source.name));
      else if (source.fileId) paths.push(await downloadTelegramFile(source.fileId, dir, source.name));
      else throw new Error("У исходника нет Telegram file_id или внешней ссылки.");
    }
    const joined = await concatSources(paths, dir);
    const withoutPauses = await removeLongPauses(joined, dir);
    const roughSegments = await transcribe(withoutPauses);
    const cleaned = await removeFillerWords(withoutPauses, roughSegments, dir);
    const segments = cleaned === withoutPauses ? roughSegments : await transcribe(cleaned);
    await sendTelegramMessage(job.chatId, `Речь расшифрована. Готовлю субтитры и финальный файл (${segments.filter((item) => item.text.trim()).length} фрагментов).`);
    const rendered = await renderVideo(cleaned, segments, dir, job.style ?? "glass");
    const output = await compressForTelegram(rendered);
    await sendTelegramVideo(job.chatId, output, `${job.id} готов. Вертикальный формат, субтитры и нормализация звука.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
