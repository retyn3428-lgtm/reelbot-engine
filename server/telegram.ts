import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type TelegramChat = { id: number };
type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string };
type TelegramVideo = { file_id: string; file_name?: string; duration?: number; mime_type?: string };
type TelegramMessage = { message_id: number; chat: TelegramChat; from?: { id: number }; text?: string; video?: TelegramVideo; document?: TelegramDocument };
type TelegramCallbackQuery = { id: string; data?: string; message?: TelegramMessage };
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type SpeechSegment = { start: number; end: number; text: string };
type SessionFile = { fileId: string; name: string };
type Session = { stage: "idle" | "awaiting_reference" | "awaiting_sources" | "ready"; reference?: SessionFile; sources: SessionFile[]; createdAt: number };
type QueueJob = { id: string; chatId: number; sourceCount: number; hasReference: boolean; status: "queued" | "analyzing" | "ready" | "failed"; createdAt: number };

type TelegramFile = { file_path?: string };
const sessions = new Map<number, Session>();
const queue: QueueJob[] = [];

function getToken() { return process.env.TELEGRAM_BOT_TOKEN ?? ""; }
function getAllowedUserId() { return Number(process.env.ALLOWED_TELEGRAM_USER_ID ?? "[OWNER_ID_REDACTED]"); }
function isAllowedUser(update: TelegramUpdate) {
  const userId = update.message?.from?.id ?? update.callback_query?.message?.from?.id ?? 0;
  const allowedUserId = getAllowedUserId();
  return allowedUserId > 0 && userId === allowedUserId;
}
function getSession(chatId: number): Session {
  const existing = sessions.get(chatId);
  if (existing) return existing;
  const fresh: Session = { stage: "idle", sources: [], createdAt: Date.now() };
  sessions.set(chatId, fresh);
  return fresh;
}
function keyboard(rows: Array<Array<{ text: string; callback_data: string }>>) { return { inline_keyboard: rows }; }

async function telegramApi<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = getToken();
  if (!token) { console.warn("[Telegram] TELEGRAM_BOT_TOKEN is not configured"); return null; }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !payload.ok) {
    console.error(`[Telegram] ${method} failed: ${payload.description ?? response.statusText}`);
    return null;
  }
  return payload.result ?? null;
}

export async function sendTelegramMessage(chatId: number, text: string, replyMarkup?: ReturnType<typeof keyboard>) {
  return telegramApi("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
async function sendTelegramVideo(chatId: number, filePath: string, caption: string) {
  const token = getToken();
  const data = await readFile(filePath);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("supports_streaming", "true");
  form.append("caption", caption);
  form.append("video", new Blob([new Uint8Array(data)], { type: "video/mp4" }), basename(filePath));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: "POST", body: form });
  const payload = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.description ?? "Telegram не принял готовое видео");
}
async function answerCallback(id: string) { await telegramApi("answerCallbackQuery", { callback_query_id: id }); }

function fileFromMessage(message: TelegramMessage): SessionFile | null {
  if (message.video) return { fileId: message.video.file_id, name: message.video.file_name ?? "video.mp4" };
  if (message.document?.mime_type?.startsWith("video/")) return { fileId: message.document.file_id, name: message.document.file_name ?? "video.mp4" };
  return null;
}
function startKeyboard() { return keyboard([[{ text: "Новый монтаж", callback_data: "new_project" }], [{ text: "Моя очередь", callback_data: "queue" }, { text: "Как это работает", callback_data: "help" }]]); }
function referenceKeyboard() { return keyboard([[{ text: "Добавить референс", callback_data: "reference" }], [{ text: "Без референса", callback_data: "skip_reference" }]]); }
function sourceKeyboard() { return keyboard([[{ text: "Добавить ещё видео", callback_data: "more_sources" }], [{ text: "Собрать готовый ролик", callback_data: "render_preview" }], [{ text: "Отменить проект", callback_data: "cancel_project" }]]); }
function inputChoiceKeyboard() { return keyboard([[{ text: "Сразу отправить мои видео", callback_data: "sources_first" }], [{ text: "Сначала добавить референс", callback_data: "reference" }]]); }
function newSession(chatId: number, stage: Session["stage"]): Session { const session: Session = { stage, sources: [], createdAt: Date.now() }; sessions.set(chatId, session); return session; }

function run(command: string, args: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} завершился с кодом ${code}: ${stderr.slice(-1200)}`)));
  });
}

function assTime(seconds: number) {
  const safe = Math.max(0, seconds); const h = Math.floor(safe / 3600); const m = Math.floor((safe % 3600) / 60); const s = safe % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
function assText(text: string) { return text.replace(/[{}\\]/g, "").replace(/\n/g, "\\N").trim(); }
function makeAss(segments: SpeechSegment[]) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Reel,DejaVu Sans,58,&H00FFFFFF,&H00FFFFFF,&H00171717,&H7A171717,-1,0,0,0,100,100,0,0,3,18,0,2,90,90,430,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = segments.filter((segment) => segment.text.trim()).map((segment) => `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Reel,,0,0,0,,${assText(segment.text)}`).join("\n");
  return header + events + "\n";
}

async function downloadTelegramFile(fileId: string, dir: string, name: string) {
  const file = await telegramApi<TelegramFile>("getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Telegram не вернул путь к видео. Возможно, файл слишком большой для обычного Bot API (лимит скачивания 20 МБ).");
  const response = await fetch(`https://api.telegram.org/file/bot${getToken()}/${file.file_path}`);
  if (!response.ok || !response.body) throw new Error("Не удалось скачать видео из Telegram");
  const output = join(dir, `${Date.now()}-${basename(name).replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  await writeFile(output, new Uint8Array(await response.arrayBuffer()));
  return output;
}

async function transcribe(videoPath: string): Promise<SpeechSegment[]> {
  const audioPath = `${videoPath}.m4a`;
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", audioPath]);
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("prompt", "Расшифруй русскую речь из видео для динамичных субтитров Reels. Сохрани смысловую пунктуацию.");
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mp4" }), "audio.m4a");
  const response = await fetch(`${process.env.MANUS_API_URL}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${process.env.MANUS_API_KEY ?? ""}` }, body: form });
  const payload = (await response.json()) as { text?: string; segments?: SpeechSegment[]; error?: unknown };
  if (!response.ok || payload.error) throw new Error("Не удалось расшифровать голос. Проверь, что в ролике есть слышимая речь.");
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
  const subtitleFilter = `subtitles=${assPath}`;
  const vertical = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=1166:2074,crop=1080:1920";
  await run("ffmpeg", ["-y", "-i", inputPath, "-vf", `${vertical},${subtitleFilter}`, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output]);
  return output;
}

async function renderJob(job: QueueJob, session: Session) {
  const dir = await mkdtemp(join(tmpdir(), "reelbot-"));
  try {
    job.status = "analyzing";
    await sendTelegramMessage(job.chatId, `Начинаю настоящий монтаж ${job.id}.\nСкачиваю ${job.sourceCount} исходник(а), убираю лишнее и готовлю субтитры.`);
    const paths: string[] = [];
    for (const source of session.sources) paths.push(await downloadTelegramFile(source.fileId, dir, source.name));
    const joined = await concatSources(paths, dir);
    const cleaned = await removeLongPauses(joined, dir);
    const segments = await transcribe(cleaned);
    await sendTelegramMessage(job.chatId, `Речь расшифрована: ${segments.filter((item) => item.text.trim()).length} смысловых фрагмента. Накладываю субтитры и собираю вертикальный MP4.`);
    const output = await renderVideo(cleaned, segments, dir);
    await sendTelegramVideo(job.chatId, output, `${job.id} готов. Стиль: стекло + динамические фразы + punch-in.`);
    job.status = "ready";
    await sendTelegramMessage(job.chatId, "Готово. Это первая реальная версия рендера. Следом добавлю выбор всех пресетов, референсный зум, цветокоррекцию, OneDrive и Dropbox.", startKeyboard());
  } catch (error) {
    job.status = "failed";
    const message = error instanceof Error ? error.message : "неизвестная ошибка обработки";
    console.error(`[ReelBot] ${job.id} failed:`, error);
    await sendTelegramMessage(job.chatId, `Не удалось собрать ${job.id}: ${message}\n\nПопробуй короткое видео до 20 МБ — это ограничение стандартного скачивания Telegram Bot API.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function showQueue(chatId: number) {
  const ownJobs = queue.filter((job) => job.chatId === chatId).slice(-5).reverse();
  if (!ownJobs.length) { await sendTelegramMessage(chatId, "Очередь пока пустая. Нажми «Новый монтаж», чтобы начать.", startKeyboard()); return; }
  const status = (job: QueueJob) => job.status === "queued" ? "ожидает" : job.status === "analyzing" ? "монтируется" : job.status === "ready" ? "готово" : "ошибка";
  await sendTelegramMessage(chatId, `Твоя очередь:\n\n${ownJobs.map((job) => `• ${job.id} — ${status(job)} · ${job.sourceCount} исходн.`).join("\n")}`, startKeyboard());
}

async function enqueuePreview(chatId: number) {
  const session = getSession(chatId);
  if (!session.sources.length) { await sendTelegramMessage(chatId, "Сначала пришли хотя бы одно исходное видео.", sourceKeyboard()); return; }
  const job: QueueJob = { id: `RB-${String(queue.length + 1).padStart(3, "0")}`, chatId, sourceCount: session.sources.length, hasReference: Boolean(session.reference), status: "queued", createdAt: Date.now() };
  queue.push(job); session.stage = "ready";
  await sendTelegramMessage(chatId, `Принято. ${job.id} запускается в обработку. Можно закрыть Telegram — я верну готовое видео сюда.`, startKeyboard());
  void renderJob(job, { ...session, sources: [...session.sources] });
}

async function handleCallback(query: TelegramCallbackQuery) {
  await answerCallback(query.id); const chatId = query.message?.chat.id; if (!chatId) return;
  switch (query.data) {
    case "new_project": newSession(chatId, "awaiting_sources"); await sendTelegramMessage(chatId, "Начинаем. По умолчанию первое видео — твоё исходное. Просто отправь его, а потом нажми «Собрать готовый ролик». Если хочешь сначала показать пример стиля, выбери кнопку ниже.", inputChoiceKeyboard()); return;
    case "sources_first": getSession(chatId).stage = "awaiting_sources"; await sendTelegramMessage(chatId, "Хорошо. Отправляй свои исходные видео — можно несколько подряд.", sourceKeyboard()); return;
    case "reference": getSession(chatId).stage = "awaiting_reference"; await sendTelegramMessage(chatId, "Пришли видео, с которого взять стиль субтитров, зум или цветокоррекцию."); return;
    case "skip_reference": newSession(chatId, "awaiting_sources"); await sendTelegramMessage(chatId, "Референс пропускаем. Теперь пришли исходные видео.", sourceKeyboard()); return;
    case "more_sources": getSession(chatId).stage = "awaiting_sources"; await sendTelegramMessage(chatId, "Пришли следующий исходник. Когда закончишь, нажми «Собрать готовый ролик»." ); return;
    case "render_preview": await enqueuePreview(chatId); return;
    case "cancel_project": newSession(chatId, "idle"); await sendTelegramMessage(chatId, "Проект отменён.", startKeyboard()); return;
    case "queue": await showQueue(chatId); return;
    case "help": await sendTelegramMessage(chatId, "1. Пришли референс или пропусти.\n2. Пришли свои исходники.\n3. Нажми «Собрать готовый ролик».\nСейчас бот реально скачивает видео, расшифровывает речь, вшивает субтитры, делает вертикальный формат и возвращает MP4.", startKeyboard()); return;
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (!isAllowedUser(update)) {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) await sendTelegramMessage(chatId, "Этот бот закрытый.");
    return;
  }
  if (update.callback_query) { await handleCallback(update.callback_query); return; }
  const message = update.message; if (!message) return; const chatId = message.chat.id; const text = (message.text ?? "").trim().toLowerCase();
  if (text === "/start" || text === "/help") { newSession(chatId, "idle"); await sendTelegramMessage(chatId, "Привет! Я ReelBot. Я могу принять референс и исходники, сделать настоящий вертикальный монтаж с расшифровкой и субтитрами.", startKeyboard()); return; }
  if (text === "/queue" || text.includes("очеред")) { await showQueue(chatId); return; }
  if ((text.includes("собери") || text.includes("сделай ролик") || text.includes("монтируй") || text === "готово" || text === "/render") && getSession(chatId).sources.length) { await enqueuePreview(chatId); return; }
  if (text.includes("новый монтаж") || text === "/new") { newSession(chatId, "awaiting_sources"); await sendTelegramMessage(chatId, "Начинаем. По умолчанию первое видео — твоё исходное. Просто отправь его. Если сначала хочешь показать пример стиля, нажми «Сначала добавить референс».", inputChoiceKeyboard()); return; }
  if (text.includes("референс") && !text.includes("без")) { getSession(chatId).stage = "awaiting_reference"; await sendTelegramMessage(chatId, "Пришли видео-референс. После него я попрошу твои исходники."); return; }
  if (text.includes("без референса") || text.includes("пропустить")) { newSession(chatId, "awaiting_sources"); await sendTelegramMessage(chatId, "Референс пропускаем. Пришли исходные видео.", sourceKeyboard()); return; }
  const file = fileFromMessage(message);
  if (file) {
    const session = getSession(chatId);
    if (session.stage === "awaiting_reference") { session.reference = file; session.stage = "awaiting_sources"; await sendTelegramMessage(chatId, `Референс принят: ${file.name}. Теперь пришли исходники.`, sourceKeyboard()); return; }
    if (session.stage === "awaiting_sources" || session.stage === "ready") { session.sources.push(file); session.stage = "awaiting_sources"; await sendTelegramMessage(chatId, `Исходник принят: ${file.name}. Всего: ${session.sources.length}.\n\nЕсли это все видео, нажми «Собрать готовый ролик» или напиши «собери».`, sourceKeyboard()); return; }
    await sendTelegramMessage(chatId, "Нажми «Новый монтаж», чтобы я понял, это референс или исходник.", startKeyboard()); return;
  }
  await sendTelegramMessage(chatId, "Выбери действие кнопками ниже.", startKeyboard());
}

export async function getTelegramBotInfo() { return telegramApi<{ id: number; is_bot: boolean; first_name: string; username?: string }>("getMe", {}); }
export async function setTelegramWebhook(webhookUrl: string) { return telegramApi<boolean>("setWebhook", { url: webhookUrl, drop_pending_updates: false }); }
export function telegramIsConfigured() { return Boolean(getToken()); }
