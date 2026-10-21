import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type SpeechSegment = { start: number; end: number; text: string };
export type RenderSource = { fileId: string; name: string };
export type RenderJob = { id: string; chatId: number; sources: RenderSource[] };

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

function makeAss(segments: SpeechSegment[]) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Reel,DejaVu Sans,58,&H00FFFFFF,&H00FFFFFF,&H00171717,&H7A171717,-1,0,0,0,100,100,0,0,3,18,0,2,90,90,430,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const events = segments
    .filter((segment) => segment.text.trim())
    .map((segment) => `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Reel,,0,0,0,,${assText(segment.text)}`)
    .join("\n");
  return `${header}${events}\n`;
}

async function transcribe(videoPath: string): Promise<SpeechSegment[]> {
  const audioPath = `${videoPath}.m4a`;
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", audioPath]);
  const script = "import json, os, sys, whisper\nmodel = whisper.load_model(os.environ.get('WHISPER_MODEL', 'tiny'))\nresult = model.transcribe(sys.argv[1], language='ru', task='transcribe', fp16=False)\nprint(json.dumps({'segments': result.get('segments', []), 'text': result.get('text', '')}, ensure_ascii=False))";
  const result = await run("python3", ["-c", script, audioPath]);
  const payload = JSON.parse(result.stdout) as { text?: string; segments?: SpeechSegment[] };
  if (payload.segments?.length) return payload.segments.map((item) => ({ start: item.start, end: item.end, text: item.text }));
  return [{ start: 0, end: 9999, text: payload.text ?? "" }];
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

async function renderVideo(inputPath: string, segments: SpeechSegment[], dir: string) {
  const assPath = join(dir, "captions.ass");
  await writeFile(assPath, makeAss(segments), "utf8");
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
    await sendTelegramMessage(job.chatId, `Начинаю монтаж ${job.id}. Скачиваю ${job.sources.length} исходник(а), делаю вертикальный MP4, удаляю длинные паузы и добавляю русские субтитры.`);
    const paths: string[] = [];
    for (const source of job.sources) paths.push(await downloadTelegramFile(source.fileId, dir, source.name));
    const joined = await concatSources(paths, dir);
    const cleaned = await removeLongPauses(joined, dir);
    const segments = await transcribe(cleaned);
    await sendTelegramMessage(job.chatId, `Речь расшифрована. Готовлю субтитры и финальный файл (${segments.filter((item) => item.text.trim()).length} фрагментов).`);
    const rendered = await renderVideo(cleaned, segments, dir);
    const output = await compressForTelegram(rendered);
    await sendTelegramVideo(job.chatId, output, `${job.id} готов. Вертикальный формат, субтитры и нормализация звука.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
