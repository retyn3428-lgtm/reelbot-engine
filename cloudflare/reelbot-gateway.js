const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 49 * 1024 * 1024;
const SESSION_TTL = 24 * 60 * 60;
const JOB_TTL = 7 * 24 * 60 * 60;
const MAX_SOURCES = 20;
const MAX_INSERTS = 10;
const MAX_PLATES = 10;
// Новое имя маркера: после выкладки вебхук переустановится сам при ближайшем запуске раннера.
const WEBHOOK_MARKER = "config:webhook-active-v3";

const CAPTION_STYLES = {
  1: { id: "glass", label: "Glass" },
  2: { id: "powder", label: "Powder" },
  3: { id: "fuchsia", label: "Fuchsia" },
  4: { id: "olive", label: "Olive" },
  5: { id: "echo", label: "Echo" },
  6: { id: "mixed", label: "Mixed Key Words" },
  7: { id: "shifted", label: "Бордовая со сдвигом" },
  8: { id: "clean", label: "Белый текст без плашки" },
};
const DEFAULT_STYLE = "shifted";
const styleById = (id) => Object.values(CAPTION_STYLES).find((item) => item.id === id);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function telegram(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram API returned ${response.status}`);
  return payload.result;
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

function captionStyleKeyboard(active) {
  const buttons = Object.values(CAPTION_STYLES).map((item) => ({ text: `${item.id === active ? "✓ " : ""}${item.label}`, callback_data: `style:${item.id}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function authorizedRunner(request, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const header = request.headers.get("authorization") || "";
  return Boolean(token && header === `Bearer ${token}`);
}

// Все ссылки Dropbox / OneDrive из сообщения.
function extractExternalVideoUrls(text) {
  const found = String(text || "").match(/https?:\/\/[^\s<>"')]+/g) || [];
  return [...new Set(found.map((value) => value.replace(/[.,;]+$/, "")).filter((value) => /dropbox\.com|1drv\.ms|onedrive\.live\.com/i.test(value)))];
}

const isFolderLink = (url) => /dropbox\.com\/(scl\/fo\/|sh\/)/i.test(url);

function isVideo(message) {
  if (message?.video?.file_id) return { fileId: message.video.file_id, name: message.video.file_name || "video.mp4", size: message.video.file_size };
  const document = message?.document;
  if (document?.file_id && String(document.mime_type || "").startsWith("video/")) {
    return { fileId: document.file_id, name: document.file_name || "video.mp4", size: document.file_size };
  }
  return null;
}

async function getJobs(env, chatId) {
  const listed = await env.STATE.list({ prefix: "job:", limit: 100 });
  const found = [];
  for (const key of listed.keys) {
    const job = await env.STATE.get(key.name, "json");
    if (job && job.chatId === chatId) found.push(job);
  }
  return found.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
}

const freshSession = (previous) => ({ sources: [], inserts: [], plates: [], createdAt: Date.now(), style: previous?.style || DEFAULT_STYLE });

// ---------- Вставки (гифки и видео поверх ролика) и плашки ----------
const INSERT_WORD = /^(\/insert|\/вставка|вставка)(@\w+)?(\s|$)/i;
const PLATE_WORD = /^(\/plate|\/плашка|плашка)(@\w+)?(\s|$)/i;
const num = (value) => Number(String(value).replace(",", "."));

// «вставка 5 3 на весь экран» → { at: 5, dur: 3, mode: "full" }. Всё необязательно.
function parseInsertArgs(raw) {
  const text = String(raw || "").replace(/https?:\/\/\S+/g, " ").toLowerCase();
  const numbers = (text.match(/\d+(?:[.,]\d+)?/g) || []).map(num);
  const args = {};
  if (numbers.length >= 1) args.at = numbers[0];
  if (numbers.length >= 2 && numbers[1] > 0) args.dur = Math.min(numbers[1], 10);
  if (/весь|полн|full/.test(text)) args.mode = "full";
  else if (/налож|поверх|угол|overlay|pip/.test(text)) args.mode = "overlay";
  return args;
}

// «плашка 2 Мой секрет» или «плашка 2-5 Мой секрет» → { at: 2, dur: 3, text: "Мой секрет" }.
function parsePlate(raw) {
  const body = String(raw || "").trim();
  const m = body.match(/^(\d+(?:[.,]\d+)?)(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?))?\s+([\s\S]+)$/);
  if (m) {
    const at = num(m[1]);
    const dur = m[2] ? Math.max(0.8, num(m[2]) - at) : 2.5;
    return { at, dur: Math.min(dur, 10), text: m[3].trim().slice(0, 90) };
  }
  return body ? { at: 0.3, dur: 3, text: body.slice(0, 90) } : null;
}

// Что пришло: гифка (в Telegram это «animation»), видео или картинка-гифка файлом.
function insertMedia(message) {
  if (message?.animation?.file_id) {
    return { fileId: message.animation.file_id, name: message.animation.file_name || "insert.mp4", size: message.animation.file_size, kind: "gif" };
  }
  const document = message?.document;
  if (document?.file_id && String(document.mime_type || "") === "image/gif") {
    return { fileId: document.file_id, name: document.file_name || "insert.gif", size: document.file_size, kind: "gif" };
  }
  const video = isVideo(message);
  return video ? { ...video, kind: "video" } : null;
}

const describeInsert = (item) => {
  const parts = [item.mode === "full" ? "на весь экран" : item.mode === "overlay" ? "поверх ролика" : (item.kind === "gif" ? "поверх ролика" : "на весь экран")];
  parts.push(item.at == null ? "время подберу сама" : `с ${item.at} сек`);
  if (item.dur) parts.push(`${item.dur} сек`);
  return parts.join(", ");
};

async function saveSession(env, chatId, session) {
  await env.STATE.put(`session:${chatId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

// Кладёт файл либо в исходники, либо в референс (если перед этим была команда «референс»).
function acceptItem(session, item) {
  if (session.awaitingReference) {
    session.reference = item;
    session.awaitingReference = false;
    return "reference";
  }
  session.sources.push(item);
  return "source";
}

async function handleTelegram(request, env) {
  if (!env.STATE || !env.TELEGRAM_BOT_TOKEN || !env.ALLOWED_TELEGRAM_USER_ID || !env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Service not configured", { status: 503 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const message = update.message || update.callback_query?.message;
  const senderId = String(update.message?.from?.id ?? update.callback_query?.from?.id ?? "");
  const chatId = message?.chat?.id;
  if (!chatId) return new Response("ok");

  if (senderId !== String(env.ALLOWED_TELEGRAM_USER_ID)) {
    await sendMessage(env, chatId, "Этот бот закрытый и доступен только владельцу.");
    return new Response("ok");
  }

  const sessionKey = `session:${chatId}`;
  let session = await env.STATE.get(sessionKey, "json");

  // Нажатие кнопки выбора стиля.
  if (update.callback_query?.data?.startsWith("style:")) {
    const selected = styleById(update.callback_query.data.slice(6));
    if (selected) {
      session ||= freshSession();
      session.style = selected.id;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: `Выбрано: ${selected.label}` });
      await sendMessage(env, chatId, `Стиль выбран: ${selected.label}. Теперь отправь видео или ссылку, либо напиши «собери».`);
    }
    return new Response("ok");
  }
  if (update.callback_query) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
    return new Response("ok");
  }

  const text = String(update.message?.text || "").trim();
  const normalized = text.toLowerCase();

  if (normalized === "/start" || normalized === "/help") {
    await sendMessage(env, chatId, "Привет! Я закрытый ReelBot.\n\n/new — новый проект\n/styles — выбрать стиль субтитров\n/ref — прислать референс (зум возьму из него)\n/insert — вставка: гифка или видео поверх ролика\n/plate — плашка с текстом\n/clear — убрать все вставки и плашки\n\nПришли видео (до 20 МБ) или ссылки Dropbox/OneDrive на файлы (до 20 штук), потом напиши «собери». Я сделаю вертикальный ролик с субтитрами, удалением пауз, зумами и нормализацией звука, а потом скажу, сильный ли хук.\n\nВставки: напиши «вставка 5» и пришли гифку или видео (5 — секунда в готовом ролике). «вставка 5 3» — на 3 секунды. «вставка 5 на весь экран» или «вставка 5 поверх». Без цифр — поставлю сама. Можно просто отправить гифку с такой подписью.\nПлашки: «плашка 2 Мой секрет» или «плашка 2-5 Мой секрет» (с 2-й по 5-ю секунду).");
    return new Response("ok");
  }

  if (normalized === "/styles" || normalized === "стили") {
    session ||= freshSession();
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Выбери стиль субтитров. Сейчас: ${styleById(session.style || DEFAULT_STYLE)?.label}.`, captionStyleKeyboard(session.style || DEFAULT_STYLE));
    return new Response("ok");
  }

  if (normalized === "/new" || normalized === "новый монтаж") {
    await saveSession(env, chatId, freshSession(session));
    await sendMessage(env, chatId, "Новый проект готов. Отправь исходное видео (до 20 МБ) или ссылку Dropbox/OneDrive. Можно несколько, затем напиши «собери». Стиль субтитров: /styles. Референс: /ref. Вставки: /insert. Плашки: /plate.");
    return new Response("ok");
  }

  if (normalized === "/ref" || (normalized.includes("референс") && !normalized.includes("без"))) {
    session ||= freshSession();
    session.awaitingReference = true;
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "Пришли видео-референс (до 20 МБ) или ссылку Dropbox/OneDrive. Зум возьму оттуда.");
    return new Response("ok");
  }

  if (normalized === "/queue" || normalized === "моя очередь") {
    const jobs = await getJobs(env, chatId);
    if (!jobs.length) await sendMessage(env, chatId, "Очередь пока пустая. Отправь /new, чтобы начать.");
    else await sendMessage(env, chatId, `Последние задачи:\n${jobs.map((j) => `• ${j.id} — ${j.status === "queued" ? "ожидает запуска" : j.status === "processing" ? "монтируется" : j.status === "ready" ? "готово" : "ошибка"}`).join("\n")}`);
    return new Response("ok");
  }

  if (normalized === "/clear" || normalized === "убери вставки") {
    session ||= freshSession();
    session.inserts = [];
    session.plates = [];
    session.awaitingInsert = null;
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "Вставки и плашки убрала.");
    return new Response("ok");
  }

  if (PLATE_WORD.test(text)) {
    session ||= freshSession();
    session.plates ||= [];
    const plate = parsePlate(text.replace(PLATE_WORD, ""));
    if (!plate) {
      await sendMessage(env, chatId, "Напиши текст плашки. Например: «плашка 2 Мой секрет» или «плашка 2-5 Мой секрет».");
      return new Response("ok");
    }
    if (session.plates.length >= MAX_PLATES) {
      await sendMessage(env, chatId, `Максимум ${MAX_PLATES} плашек. Убрать всё: /clear.`);
      return new Response("ok");
    }
    session.plates.push(plate);
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Плашка ${session.plates.length} принята: «${plate.text}», с ${plate.at} по ${Math.round((plate.at + plate.dur) * 10) / 10} сек. Ещё что-то добавить или «собери».`);
    return new Response("ok");
  }

  if (INSERT_WORD.test(text)) {
    session ||= freshSession();
    session.inserts ||= [];
    const rest = text.replace(INSERT_WORD, "");
    const link = (rest.match(/https?:\/\/[^\s<>"')]+/) || [])[0];
    const args = parseInsertArgs(rest);
    if (link) {
      if (session.inserts.length >= MAX_INSERTS) {
        await sendMessage(env, chatId, `Максимум ${MAX_INSERTS} вставок. Убрать всё: /clear.`);
        return new Response("ok");
      }
      const item = { url: link.replace(/[.,;]+$/, ""), name: /\.gif(\?|$)/i.test(link) ? "insert.gif" : "insert.mp4", kind: /\.gif(\?|$)|giphy|tenor/i.test(link) ? "gif" : "video", ...args };
      session.inserts.push(item);
      await saveSession(env, chatId, session);
      await sendMessage(env, chatId, `Вставка ${session.inserts.length} принята (${describeInsert(item)}). Ещё одну или «собери».`);
    } else {
      session.awaitingInsert = args;
      await saveSession(env, chatId, session);
      await sendMessage(env, chatId, "Пришли гифку, видео или ссылку на гифку. Это будет вставка.");
    }
    return new Response("ok");
  }

  // Гифка, видео или ссылка после команды «вставка» (или гифка/видео с подписью «вставка 5»).
  {
    const media = insertMedia(message);
    const caption = String(update.message?.caption || "").trim();
    const captionIsInsert = INSERT_WORD.test(caption);
    const anyLink = (text.match(/https?:\/\/[^\s<>"')]+/) || [])[0];
    const waiting = Boolean(session?.awaitingInsert);
    const asInsert = (media && (media.kind === "gif" || waiting || captionIsInsert)) || (waiting && anyLink);
    if (asInsert) {
      session ||= freshSession();
      session.inserts ||= [];
      if (session.inserts.length >= MAX_INSERTS) {
        await sendMessage(env, chatId, `Максимум ${MAX_INSERTS} вставок. Убрать всё: /clear.`);
        return new Response("ok");
      }
      if (media && Number(media.size || 0) > MAX_INPUT_BYTES) {
        await sendMessage(env, chatId, "Файл больше 20 МБ. Пришли файл поменьше или ссылку.");
        return new Response("ok");
      }
      const args = { ...(session.awaitingInsert || {}), ...parseInsertArgs(caption.replace(INSERT_WORD, "")) };
      const base = media
        ? { fileId: media.fileId, name: media.name, kind: media.kind }
        : { url: anyLink.replace(/[.,;]+$/, ""), name: /\.gif(\?|$)/i.test(anyLink) ? "insert.gif" : "insert.mp4", kind: /\.gif(\?|$)|giphy|tenor/i.test(anyLink) ? "gif" : "video" };
      const item = { ...base, ...args };
      session.inserts.push(item);
      session.awaitingInsert = null;
      await saveSession(env, chatId, session);
      await sendMessage(env, chatId, `Вставка ${session.inserts.length} принята (${describeInsert(item)}). Ещё одну или «собери».`);
      return new Response("ok");
    }
  }

  const urls = extractExternalVideoUrls(text);
  if (urls.length) {
    session ||= freshSession();
    session.sources ||= [];
    const folder = urls.find(isFolderLink);
    if (folder && urls.length === 1) {
      await sendMessage(env, chatId, "Это ссылка на папку Dropbox. Пришли ссылки на отдельные видеофайлы.");
      return new Response("ok");
    }
    let addedSources = 0;
    let addedReference = false;
    for (const url of urls.filter((value) => !isFolderLink(value))) {
      if (!session.awaitingReference && session.sources.length >= MAX_SOURCES) break;
      const kind = acceptItem(session, { url, name: "cloud-video.mp4" });
      if (kind === "reference") addedReference = true; else addedSources += 1;
    }
    await saveSession(env, chatId, session);
    const parts = [];
    if (addedReference) parts.push("Референс принят.");
    if (addedSources) parts.push(`Ссылок принято: ${addedSources} (всего ${session.sources.length}/${MAX_SOURCES}).`);
    if (session.sources.length >= MAX_SOURCES) parts.push("Это максимум на проект.");
    if (folder) parts.push("Ссылку на папку пропустила, нужны ссылки на файлы.");
    parts.push("Пришли ещё или напиши «собери».");
    await sendMessage(env, chatId, parts.join(" "));
    return new Response("ok");
  }

  const source = isVideo(message);
  if (source) {
    if (Number(source.size || 0) > MAX_INPUT_BYTES) {
      await sendMessage(env, chatId, "Файл больше 20 МБ. Пришли ссылку Dropbox или OneDrive на этот файл, либо видео до 20 МБ.");
      return new Response("ok");
    }
    session ||= freshSession();
    session.sources ||= [];
    if (!session.awaitingReference && session.sources.length >= MAX_SOURCES) {
      await sendMessage(env, chatId, `В одном проекте максимум ${MAX_SOURCES} исходников. Напиши «собери» или начни новый через /new.`);
      return new Response("ok");
    }
    const kind = acceptItem(session, { fileId: source.fileId, name: source.name });
    await saveSession(env, chatId, session);
    if (kind === "reference") {
      await sendMessage(env, chatId, "Референс принят. Теперь пришли исходные видео.");
    } else {
      await sendMessage(env, chatId, `Видео принято (${session.sources.length}/${MAX_SOURCES}). Выбери стиль субтитров, пришли ещё видео или напиши «собери».`, captionStyleKeyboard(session.style || DEFAULT_STYLE));
    }
    return new Response("ok");
  }

  if (["собери", "собрать", "/render", "/собери"].includes(normalized)) {
    if (!session?.sources?.length) {
      await sendMessage(env, chatId, "Сначала отправь /new и хотя бы одно видео или ссылку.");
      return new Response("ok");
    }
    const id = `RB-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const style = session.style || DEFAULT_STYLE;
    const job = { id, chatId, sources: session.sources, reference: session.reference || null, inserts: session.inserts || [], plates: session.plates || [], style, status: "queued", createdAt: Date.now(), attempts: 0 };
    await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
    await env.STATE.put(sessionKey, JSON.stringify({ ...freshSession(session) }), { expirationTtl: SESSION_TTL });
    await sendMessage(env, chatId, `Задача ${id} сохранена. Стиль: ${styleById(style)?.label}.${job.reference ? " Зум возьму из референса." : ""}${job.inserts.length ? ` Вставок: ${job.inserts.length}.` : ""}${job.plates.length ? ` Плашек: ${job.plates.length}.` : ""} Монтаж стартует в течение нескольких минут, готовый ролик пришлю сюда. Статус: /queue.`);
    return new Response("ok");
  }

  if (text) {
    await sendMessage(env, chatId, "Чтобы начать, отправь /new. После загрузки видео напиши «собери».");
  }
  return new Response("ok");
}

async function handleRunner(request, env, url) {
  if (!authorizedRunner(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.STATE) return json({ error: "storage_not_configured" }, 503);

  if (url.pathname === "/runner/activate" && request.method === "POST") {
    const marker = await env.STATE.get(WEBHOOK_MARKER, "json");
    if (!marker || Date.now() - marker.setAt > 12 * 60 * 60 * 1000) {
      const origin = new URL(request.url).origin;
      await telegram(env, "setWebhook", {
        url: `${origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
        // callback_query нужен, иначе нажатия кнопок выбора стиля до бота не доходят.
        allowed_updates: ["message", "callback_query"],
      });
      await env.STATE.put(WEBHOOK_MARKER, JSON.stringify({ setAt: Date.now() }), { expirationTtl: 24 * 60 * 60 });
    }
    return json({ ok: true });
  }

  // Дешёвая проверка «есть ли что монтировать» — чтобы расписание не ставило тяжёлые программы зря.
  if (url.pathname === "/runner/peek" && request.method === "POST") {
    const listed = await env.STATE.list({ prefix: "job:", limit: 100 });
    let pending = 0;
    for (const key of listed.keys) {
      const job = await env.STATE.get(key.name, "json");
      if (!job) continue;
      if (job.status === "queued" || (job.status === "processing" && Date.now() - Number(job.claimedAt || 0) > 60 * 60 * 1000)) pending += 1;
    }
    return json({ pending });
  }

  if (url.pathname === "/runner/next" && request.method === "POST") {
    const listed = await env.STATE.list({ prefix: "job:", limit: 100 });
    const jobs = [];
    for (const key of listed.keys) {
      const job = await env.STATE.get(key.name, "json");
      if (job) jobs.push({ key: key.name, job });
    }
    jobs.sort((a, b) => a.job.createdAt - b.job.createdAt);
    for (const entry of jobs) {
      const job = entry.job;
      if (job.status === "processing" && Date.now() - Number(job.claimedAt || 0) > 60 * 60 * 1000) job.status = "queued";
      if (job.status !== "queued") continue;
      job.status = "processing";
      job.claimedAt = Date.now();
      job.attempts = Number(job.attempts || 0) + 1;
      await env.STATE.put(entry.key, JSON.stringify(job), { expirationTtl: JOB_TTL });
      return json({ job });
    }
    return json({ job: null });
  }

  if (url.pathname === "/runner/message" && request.method === "POST") {
    const body = await request.json();
    if (!body.chatId || !body.text) return json({ error: "invalid_request" }, 400);
    await sendMessage(env, body.chatId, String(body.text).slice(0, 3900));
    return json({ ok: true });
  }

  if (url.pathname === "/runner/file" && request.method === "POST") {
    const body = await request.json();
    if (!body.fileId) return json({ error: "file_id_required" }, 400);
    const info = await telegram(env, "getFile", { file_id: body.fileId });
    if (!info?.file_path) return json({ error: "file_not_found" }, 404);
    if (Number(info.file_size || 0) > MAX_INPUT_BYTES) return json({ error: "file_too_large", maxBytes: MAX_INPUT_BYTES }, 413);
    const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
    if (!response.ok || !response.body) return json({ error: "file_download_failed" }, 502);
    return new Response(response.body, {
      headers: {
        "content-type": response.headers.get("content-type") || "application/octet-stream",
        "cache-control": "no-store",
        ...(response.headers.get("content-length") ? { "content-length": response.headers.get("content-length") } : {}),
      },
    });
  }

  if (url.pathname === "/runner/video" && request.method === "POST") {
    const input = await request.formData();
    const chatId = input.get("chat_id");
    const caption = input.get("caption");
    const video = input.get("video");
    if (!chatId || !(video instanceof File)) return json({ error: "invalid_video_upload" }, 400);
    if (video.size > MAX_OUTPUT_BYTES) return json({ error: "output_too_large", maxBytes: MAX_OUTPUT_BYTES }, 413);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("supports_streaming", "true");
    form.append("caption", String(caption || ""));
    form.append("video", video, "reelbot-result.mp4");
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVideo`, { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) return json({ error: result.description || "telegram_upload_failed" }, 502);
    return json({ ok: true });
  }

  if (["/runner/complete", "/runner/fail"].includes(url.pathname) && request.method === "POST") {
    const body = await request.json();
    const key = `job:${body.jobId}`;
    const job = await env.STATE.get(key, "json");
    if (!job) return json({ error: "job_not_found" }, 404);
    if (url.pathname === "/runner/complete") {
      job.status = "ready";
      job.completedAt = Date.now();
      await env.STATE.put(key, JSON.stringify(job), { expirationTtl: JOB_TTL });
      await sendMessage(env, job.chatId, `Готово — ${job.id}. Ролик смонтирован, субтитры добавлены, звук нормализован.`);
    } else {
      job.status = "failed";
      job.failedAt = Date.now();
      job.error = String(body.error || "unknown").slice(0, 500);
      await env.STATE.put(key, JSON.stringify(job), { expirationTtl: JOB_TTL });
      await sendMessage(env, job.chatId, `Не удалось собрать ${job.id}: ${String(body.userMessage || "ошибка обработки").slice(0, 2500)}`);
    }
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "reelbot-gateway", version: 4, storageConfigured: Boolean(env.STATE), privateBot: true });
    }
    try {
      if (url.pathname === "/telegram" && request.method === "POST") return await handleTelegram(request, env);
      if (url.pathname.startsWith("/runner/")) return await handleRunner(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Тела запросов, идентификаторы и токены в логи не попадают.
      console.error("[ReelBot] request failed", error instanceof Error ? error.message : "unknown error");
      return json({ error: "request_failed" }, 500);
    }
  },
};
