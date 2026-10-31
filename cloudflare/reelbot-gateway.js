const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 49 * 1024 * 1024;
const SESSION_TTL = 24 * 60 * 60;
const JOB_TTL = 7 * 24 * 60 * 60;
const MAX_SOURCES = 20;
const MAX_INSERTS = 10;
const MAX_PLATES = 10;
const MAX_MEDIA_SEARCH_RESULTS = 6;
const CAPTION_POSITIONS = {
  auto: "Автоматически — в свободную зону",
  bottom: "Внизу",
  top: "Сверху",
};
const CAMERA_MODES = { standard: "Обычные наезды", none: "Без движения", boosted: "Усиленные наезды" };
const SPEED_OPTIONS = [1, 1.1, 1.2, 1.3, 1.5];
const VIDEO_FILTERS = {
  original: "Как снято",
  clean: "Чистый",
  peach: "Персик",
  soft: "Нежный",
  cool: "Холод",
  film: "Плёнка",
  contrast: "Контраст",
  bright: "Ясный",
  warm: "Тёплый",
};
// Новое имя маркера: после выкладки вебхук переустановится сам при ближайшем запуске раннера.
const WEBHOOK_MARKER = "config:webhook-active-v3";

const CAPTION_STYLES = {
  1: { id: "shifted", label: "Бордовая со сдвигом" },
  2: { id: "clean", label: "Белый текст + тень" },
  3: { id: "karaoke_yellow", label: "Белый + жёлтое слово" },
  4: { id: "karaoke_pink", label: "Белый + розовое слово" },
  5: { id: "karaoke_red", label: "Белый + красное слово" },
  6: { id: "glass_bar", label: "Тёмная прозрачная плашка" },
};
const DEFAULT_STYLE = "shifted";
const LEGACY_STYLES = new Set(["glass", "powder", "fuchsia", "olive", "echo", "mixed"]);
const PLATE_OPACITY_OPTIONS = [20, 30, 40, 50, 60, 70, 80];
const DEFAULT_PLATE_OPACITY = 60;
const CAPTION_FONTS = { inter: "Inter", montserrat: "Montserrat", oswald: "Oswald" };
const DEFAULT_CAPTION_FONT = "montserrat";
const styleById = (id) => Object.values(CAPTION_STYLES).find((item) => item.id === id);
const normalizeStyleId = (id) => styleById(id)?.id || DEFAULT_STYLE;
const captionPositionKeyboard = (active) => ({ inline_keyboard: [[
  { text: `${active === "auto" ? "✓ " : ""}Автоматически`, callback_data: "caption-position:auto" },
  { text: `${active === "bottom" ? "✓ " : ""}Внизу`, callback_data: "caption-position:bottom" },
  { text: `${active === "top" ? "✓ " : ""}Сверху`, callback_data: "caption-position:top" },
]] });
const optionKeyboard = (group, options, active) => {
  const values = Object.entries(options).map(([id, label]) => ({
    text: `${id === active ? "✓ " : ""}${label}`,
    callback_data: `${group}:${id}`,
  }));
  const rows = [];
  for (let i = 0; i < values.length; i += 2) rows.push(values.slice(i, i + 2));
  return { inline_keyboard: rows };
};

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

function plateOpacityKeyboard(active) {
  const values = PLATE_OPACITY_OPTIONS.map((value) => ({
    text: `${value === active ? "✓ " : ""}${value}%`, callback_data: `plate-opacity:${value}`,
  }));
  return { inline_keyboard: [values.slice(0, 4), values.slice(4)] };
}

function captionFontKeyboard(active) {
  return { inline_keyboard: Object.entries(CAPTION_FONTS).map(([id, label]) => [{
    text: `${id === active ? "✓ " : ""}${label}`, callback_data: `caption-font:${id}`,
  }]) };
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

const freshSession = (previous) => ({
  sources: [], inserts: [], plates: [], createdAt: Date.now(),
  style: normalizeStyleId(previous?.style),
  plateOpacity: PLATE_OPACITY_OPTIONS.includes(Number(previous?.plateOpacity)) ? Number(previous.plateOpacity) : DEFAULT_PLATE_OPACITY,
  captionFont: Object.hasOwn(CAPTION_FONTS, previous?.captionFont) ? previous.captionFont : DEFAULT_CAPTION_FONT,
  captionPosition: previous?.captionPosition || "auto",
  cameraMode: previous?.cameraMode || "standard",
  speed: previous?.speed || 1,
  colorFilter: previous?.colorFilter || "original",
  captionEdits: [],
});

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

function plainMetadata(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

function reusableLicense(label, licenseUrl, artist) {
  const name = plainMetadata(label);
  const url = plainMetadata(licenseUrl);
  const isPublicDomain = /^(?:CC0|Public domain(?: mark)?|PDM)$/i.test(name);
  const isCCBy = /^CC BY(?:\s+\d+(?:\.\d+)?)?$/i.test(name) && Boolean(artist && url);
  return (isPublicDomain || isCCBy) ? { name, url, requiresCredit: isCCBy } : null;
}

async function searchCommonsAssets(query) {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({
    action: "query", format: "json", formatversion: "2", generator: "search",
    gsrsearch: query.slice(0, 100), gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|mime|size|extmetadata",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|AttributionRequired",
    maxlag: "2",
  })) api.searchParams.set(key, value);
  const response = await fetch(api, {
    headers: { "Api-User-Agent": "ReelBot/5.0 (https://github.com/retyn3428-lgtm/reelbot-engine)", accept: "application/json" },
  });
  if (!response.ok) throw new Error(`commons_http_${response.status}`);
  const payload = await response.json();
  const pages = payload?.query?.pages || [];
  return (Array.isArray(pages) ? pages : Object.values(pages)).flatMap((page) => {
    const info = page?.imageinfo?.[0];
    if (!info?.url || Number(info.size || 0) <= 0 || Number(info.size || 0) > MAX_INPUT_BYTES) return [];
    const mime = String(info.mime || "").toLowerCase();
    const title = String(page.title || "");
    const kind = mime === "image/gif" || /\.gif$/i.test(title) ? "gif" : mime.startsWith("video/") ? "video" : null;
    if (!kind) return [];
    const meta = info.extmetadata || {};
    const artist = plainMetadata(meta.Artist?.value || meta.Credit?.value);
    const license = reusableLicense(meta.LicenseShortName?.value, meta.LicenseUrl?.value, artist);
    if (!license) return [];
    return [{
      title: title.replace(/^File:/, "").slice(0, 100),
      url: info.url,
      descriptionUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      name: title.split(":").pop() || (kind === "gif" ? "commons.gif" : "commons-video.mp4"),
      kind, size: Number(info.size), license: license.name, licenseUrl: license.url,
      artist: artist || "Автор не указан в метаданных",
      attribution: license.requiresCredit ? `${artist}. ${license.name}. ${license.url}. Материал изменён: обрезка/монтаж.` : "Свободный материал с Wikimedia Commons (CC0 / Public Domain).",
    }];
  }).slice(0, MAX_MEDIA_SEARCH_RESULTS);
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
      await sendMessage(env, chatId, `Стиль выбран: ${selected.label}. Блоки субтитров будут одного цвета; подсветка движется по произносимым словам, если она есть в выбранном стиле.`);
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("plate-opacity:")) {
    const value = Number(update.callback_query.data.slice("plate-opacity:".length));
    if (PLATE_OPACITY_OPTIONS.includes(value)) {
      session ||= freshSession();
      session.plateOpacity = value;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: `Плотность плашки: ${value}%` });
      await sendMessage(env, chatId, `Плотность заливки плашки: ${value}%. Чем меньше процент, тем прозрачнее плашка.`, plateOpacityKeyboard(value));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("caption-font:")) {
    const id = update.callback_query.data.slice("caption-font:".length);
    if (Object.hasOwn(CAPTION_FONTS, id)) {
      session ||= freshSession();
      session.captionFont = id;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: `Шрифт: ${CAPTION_FONTS[id]}` });
      await sendMessage(env, chatId, `Шрифт субтитров: ${CAPTION_FONTS[id]}. Он встроен в проект и поддерживает русский текст.`, captionFontKeyboard(id));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("caption-position:")) {
    const position = update.callback_query.data.slice("caption-position:".length);
    if (Object.hasOwn(CAPTION_POSITIONS, position)) {
      session ||= freshSession();
      session.captionPosition = position;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: CAPTION_POSITIONS[position] });
      await sendMessage(env, chatId, `Положение субтитров: ${CAPTION_POSITIONS[position]}.`, captionPositionKeyboard(position));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("camera-mode:")) {
    const mode = update.callback_query.data.slice("camera-mode:".length);
    if (Object.hasOwn(CAMERA_MODES, mode)) {
      session ||= freshSession();
      session.cameraMode = mode;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: CAMERA_MODES[mode] });
      await sendMessage(env, chatId, `Движение камеры: ${CAMERA_MODES[mode]}.`, optionKeyboard("camera-mode", CAMERA_MODES, mode));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("speed:")) {
    const speed = num(update.callback_query.data.slice("speed:".length));
    if (SPEED_OPTIONS.includes(speed)) {
      session ||= freshSession();
      session.speed = speed;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: `Скорость ×${speed}` });
      await sendMessage(env, chatId, `Скорость: ×${speed}. Высота голоса будет сохранена.`, optionKeyboard("speed", Object.fromEntries(SPEED_OPTIONS.map((value) => [String(value), `×${value}`])), String(speed)));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("filter:")) {
    const filter = update.callback_query.data.slice("filter:".length);
    if (Object.hasOwn(VIDEO_FILTERS, filter)) {
      session ||= freshSession();
      session.colorFilter = filter;
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: VIDEO_FILTERS[filter] });
      await sendMessage(env, chatId, `Цветовой фильтр: ${VIDEO_FILTERS[filter]}.`, optionKeyboard("filter", VIDEO_FILTERS, filter));
    }
    return new Response("ok");
  }
  if (update.callback_query?.data?.startsWith("media-add:")) {
    const index = Number(update.callback_query.data.slice("media-add:".length));
    const candidate = session?.mediaCandidates?.[index];
    if (!candidate) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Список устарел. Найди вставки ещё раз." });
      return new Response("ok");
    }
    session.inserts ||= [];
    if (session.inserts.length >= MAX_INSERTS) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: `Максимум ${MAX_INSERTS} вставок в проекте.` });
      return new Response("ok");
    }
    const item = {
      url: candidate.url, name: candidate.name, kind: candidate.kind,
      mode: candidate.kind === "gif" ? "overlay" : "full",
      attribution: candidate.attribution, artist: candidate.artist,
      license: candidate.license, licenseUrl: candidate.licenseUrl,
      sourceUrl: candidate.descriptionUrl, sourceName: "Wikimedia Commons",
      id: crypto.randomUUID(), createdAt: Date.now(),
    };
    session.inserts.push(item);
    session.mediaCandidates = [];
    await saveSession(env, chatId, session);
    await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Вставка добавлена в проект" });
    await sendMessage(env, chatId, `Добавила «${candidate.title}» в проект. Поставлю автоматически после начала ролика. Источник: ${candidate.descriptionUrl}\nЛицензия: ${candidate.license}. Проверь карточку источника перед публикацией. Если нужна строка авторства — пришлю её после сборки.`, { inline_keyboard: [[{ text: "Убрать эту вставку", callback_data: "media-undo-last" }]] });
    return new Response("ok");
  }
  if (update.callback_query?.data === "media-undo-last") {
    if (session?.inserts?.length) {
      const [removed] = session.inserts.splice(-1, 1);
      await saveSession(env, chatId, session);
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Вставку убрала" });
      await sendMessage(env, chatId, `Убрала последнюю вставку${removed?.name ? ` «${removed.name}»` : ""}.`);
    } else {
      await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Вставок нет" });
    }
    return new Response("ok");
  }
  if (update.callback_query) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
    return new Response("ok");
  }

  const text = String(update.message?.text || "").trim();
  const normalized = text.toLowerCase();

  const editJobMatch = text.match(/^\/edit(?:@\w+)?\s+(RB-[A-Z0-9-]+)$/i);
  if (editJobMatch) {
    const original = await env.STATE.get(`job:${editJobMatch[1]}`, "json");
    if (!original || String(original.chatId) !== String(chatId) || original.status !== "ready" || !original.sources?.length || original.kind === "creative") {
      await sendMessage(env, chatId, "Не нашла готовый ролик с исходниками по этому номеру. Номер можно взять в /queue; готовые проекты хранятся до 7 дней.");
      return new Response("ok");
    }
    session = {
      sources: original.sources, reference: original.reference || null,
      inserts: original.inserts || [], plates: original.plates || [],
      style: normalizeStyleId(original.style),
      plateOpacity: PLATE_OPACITY_OPTIONS.includes(Number(original.plateOpacity)) ? Number(original.plateOpacity) : DEFAULT_PLATE_OPACITY,
      captionFont: Object.hasOwn(CAPTION_FONTS, original.captionFont) ? original.captionFont : DEFAULT_CAPTION_FONT,
      captionPosition: original.captionPosition || "auto",
      cameraMode: original.cameraMode || "standard", speed: original.speed || 1,
      colorFilter: original.colorFilter || "original",
      captionEdits: original.captionEdits || [], editingJobId: original.id,
      createdAt: Date.now(),
    };
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Открыла проект ${original.id}. Теперь можно исправить текст: «/caption-edit 12 Нужная фраза», выбрать место субтитров, убрать или добавить слой, а затем написать «собери». Время указывается по готовому ролику после вырезания пауз. При сборке исходник будет обработан заново; сохранённого предпросмотра отдельных видеослоёв пока нет. Для списка слоёв: /layers.`);
    return new Response("ok");
  }

  const captionEditMatch = text.match(/^\/(?:caption-edit|fixcaption)(?:@\w+)?\s+(\d+(?:[.,]\d+)?)\s+([\s\S]+)$/i);
  if (captionEditMatch) {
    session ||= freshSession();
    if (!session.sources?.length) {
      await sendMessage(env, chatId, "Сначала открой готовый проект командой «/edit НОМЕР» или начни новый монтаж.");
      return new Response("ok");
    }
    const at = num(captionEditMatch[1]);
    const replacement = captionEditMatch[2].trim().slice(0, 160);
    if (!Number.isFinite(at) || at < 0 || at > 3600 || !replacement) {
      await sendMessage(env, chatId, "Напиши секунду и нужный текст. Например: «/caption-edit 12 Здесь должна быть моя фраза».");
      return new Response("ok");
    }
    session.captionEdits ||= [];
    const existing = session.captionEdits.find((edit) => Math.abs(Number(edit.at) - at) < 0.05);
    if (existing) existing.text = replacement;
    else session.captionEdits.push({ at, text: replacement, createdAt: Date.now() });
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Исправление сохранено для фразы около ${at} сек: «${replacement}». Остальные подписи останутся как были. Проверь слои командой /layers или собери обновлённую версию.`);
    return new Response("ok");
  }

  const creativeMatch = text.match(/^(?:\/(?:script|ideas|hooks)(?:@\w+)?|сценарий|хуки|идеи)(?:\s+([\s\S]+))?$/i);
  if (creativeMatch) {
    const topic = String(creativeMatch[1] || "").trim();
    if (topic.length < 3) {
      await sendMessage(env, chatId, "Напиши тему после команды. Например: «/script как выбрать SPF для жирной кожи». Я предложу несколько разных начал и короткий сценарий.");
      return new Response("ok");
    }
    if (topic.length > 1200) {
      await sendMessage(env, chatId, "Тема слишком длинная. Напиши её коротко — до 1200 знаков.");
      return new Response("ok");
    }
    const id = `RB-SCRIPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const job = { id, chatId, kind: "creative", request: topic, status: "queued", createdAt: Date.now(), attempts: 0 };
    await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
    await sendMessage(env, chatId, `Приняла тему для сценария: «${topic.slice(0, 260)}». Подготовлю разные хуки и сценарий. Задача ${id} попадёт в очередь; бот не копирует чужие формулировки и не утверждает, что искал в Instagram.`);
    return new Response("ok");
  }

  const mediaMatch = text.match(/^(?:\/findinsert(?:@\w+)?|найди вставку|найди гифку|найди видео)(?:\s+([\s\S]+))?$/i);
  if (mediaMatch) {
    const query = String(mediaMatch[1] || "").trim();
    if (query.length < 2) {
      await sendMessage(env, chatId, "Напиши, что найти. Например: «/findinsert реакция удивление» или «/findinsert старое кино поезд». Ищу GIF и видео с пометкой CC0, Public Domain или CC BY, сохраняю ссылку на автора и лицензию.");
      return new Response("ok");
    }
    if (query.length > 100) {
      await sendMessage(env, chatId, "Сократи запрос до 100 знаков, например: «смешная реакция» или «старое кино поезд». ");
      return new Response("ok");
    }
    try {
      const results = await searchCommonsAssets(query);
      if (!results.length) {
        await sendMessage(env, chatId, "Не нашла подходящих небольших GIF или видео с указанной лицензией. Попробуй другие слова. Этот источник не гарантирует наличие популярных мемов или сцен из современных фильмов.");
        return new Response("ok");
      }
      session ||= freshSession();
      session.mediaCandidates = results;
      await saveSession(env, chatId, session);
      const keyboard = { inline_keyboard: results.map((item, index) => [{
        text: `${index + 1}. ${item.kind === "gif" ? "GIF" : "видео"}: ${item.title.slice(0, 26)} · ${item.license.slice(0, 12)}`,
        callback_data: `media-add:${index}`,
      }]) };
      const description = results.map((item, index) => `${index + 1}. ${item.title} — ${item.license}; автор: ${item.artist}; размер: ${(item.size / (1024 * 1024)).toFixed(1)} МБ\n${item.descriptionUrl}`).join("\n\n");
      await sendMessage(env, chatId, `Нашла варианты в Wikimedia Commons по запросу «${query}». Нажми нужный — добавлю как отдельную вставку в текущий проект.\n\n${description}\n\nМатериалы с CC BY требуют указания автора и ссылки на лицензию. Карточку источника всё равно нужно проверить перед публикацией.`, keyboard);
    } catch (error) {
      console.error("Commons search failed", error instanceof Error ? error.message : "unknown error");
      await sendMessage(env, chatId, "Сейчас бесплатный каталог не отвечает на поиск. Ничего не добавила. Попробуй ещё раз позже или пришли свою GIF/видео как раньше.");
    }
    return new Response("ok");
  }

  if (normalized === "/caption-position" || normalized === "/caption_position" || normalized === "положение субтитров") {
    session ||= freshSession();
    const position = session.captionPosition || "auto";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Сейчас: ${CAPTION_POSITIONS[position]}. Автоматический режим старается поставить подписи в свободную зону кадра; при неуверенном распознавании лица остаётся обычное положение.`, captionPositionKeyboard(position));
    return new Response("ok");
  }

  if (["/plate-opacity", "прозрачность плашки"].includes(normalized)) {
    session ||= freshSession();
    const opacity = PLATE_OPACITY_OPTIONS.includes(Number(session.plateOpacity)) ? Number(session.plateOpacity) : DEFAULT_PLATE_OPACITY;
    session.plateOpacity = opacity;
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Плотность заливки плашки: ${opacity}%. 20% почти прозрачная, 80% плотная. Настройка применяется к бордовой и тёмной округлой плашкам.`, plateOpacityKeyboard(opacity));
    return new Response("ok");
  }

  if (["/font", "шрифт субтитров"].includes(normalized)) {
    session ||= freshSession();
    const font = Object.hasOwn(CAPTION_FONTS, session.captionFont) ? session.captionFont : DEFAULT_CAPTION_FONT;
    session.captionFont = font;
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Выбери шрифт для русских субтитров. Сейчас: ${CAPTION_FONTS[font]}.`, captionFontKeyboard(font));
    return new Response("ok");
  }

  if (["/motion", "движение камеры"].includes(normalized)) {
    session ||= freshSession();
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Сейчас: ${CAMERA_MODES[session.cameraMode || "standard"]}.`, optionKeyboard("camera-mode", CAMERA_MODES, session.cameraMode || "standard"));
    return new Response("ok");
  }
  if (["/speed", "скорость"].includes(normalized)) {
    session ||= freshSession();
    await saveSession(env, chatId, session);
    const options = Object.fromEntries(SPEED_OPTIONS.map((value) => [String(value), `×${value}`]));
    await sendMessage(env, chatId, `Сейчас: ×${session.speed || 1}.`, optionKeyboard("speed", options, String(session.speed || 1)));
    return new Response("ok");
  }
  if (["/filter", "фильтр"].includes(normalized)) {
    session ||= freshSession();
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, `Сейчас: ${VIDEO_FILTERS[session.colorFilter || "original"]}.`, optionKeyboard("filter", VIDEO_FILTERS, session.colorFilter || "original"));
    return new Response("ok");
  }

  if (normalized === "/start" || normalized === "/help") {
    await sendMessage(env, chatId, "Привет! Я закрытый ReelBot.\n\n/new — новый проект\n/styles — выбрать вид субтитров\n/plate-opacity — плотность заливки плашки 20–80%\n/font — шрифт Inter, Montserrat или Oswald\n/caption-position — место субтитров\n/motion — движение камеры: обычное, без движения или усиленное\n/speed — скорость от ×1 до ×1,5\n/filter — один из восьми цветовых вариантов\n/ref — референс движения камеры\n/insert — добавить свою GIF или видео\n/findinsert тема — найти GIF/видео со свободной лицензией\n/plate — текстовая плашка\n/layers — посмотреть слои проекта\n/undo — отменить последний слой\n/remove layer 2 — убрать один слой\n/edit RB-НОМЕР — открыть готовый проект (до 7 дней)\n/caption-edit 12 текст — исправить одну фразу\n/clear — убрать все вставки и плашки\n/script тема — придумать хуки и сценарий\n\nВ /styles есть бордовая плашка со сдвигом, чистый белый текст и белые субтитры с подсветкой одного произносимого слова. Случайного чередования розовой и серой плашек больше нет.\n\nПришли видео (до 20 МБ) или ссылки Dropbox/OneDrive (до 20 штук), затем напиши «собери». Бот удалит длинные паузы, добавит субтитры, применит выбранное движение и обработку цвета, нормализует звук и разберёт начало ролика.\n\nВставка: «вставка 5» и затем GIF/видео — поместить на 5-ю секунду готового ролика. Можно указать длительность: «вставка 5 3». Без времени бот выберет момент после начала ролика. Слои можно менять перед сборкой.\nПоиск: «/findinsert реакция удивление». Источник показывает небольшие GIF/видео с метками CC0, Public Domain или CC BY и страницу лицензии. Это не каталог всех мемов и не разрешение на любые современные кинофрагменты.\nПравка готового ролика: «/edit RB-НОМЕР», затем «/caption-edit 12 Нужная фраза» или команды для слоёв. При обновлении исходное видео будет обработано заново; пока нет отдельного хранения уже обработанных слоёв.\nСценарий: «/script тема ролика». Бот предлагает оригинальные начала и структуру, не копирует чужие фразы и не заявляет, что искал в Instagram.");
    return new Response("ok");
  }

  if (normalized === "/styles" || normalized === "стили") {
    session ||= freshSession();
    const replacedOldStyle = LEGACY_STYLES.has(session.style);
    session.style = normalizeStyleId(session.style);
    session.plateOpacity = PLATE_OPACITY_OPTIONS.includes(Number(session.plateOpacity)) ? Number(session.plateOpacity) : DEFAULT_PLATE_OPACITY;
    session.captionFont = Object.hasOwn(CAPTION_FONTS, session.captionFont) ? session.captionFont : DEFAULT_CAPTION_FONT;
    await saveSession(env, chatId, session);
    const note = replacedOldStyle ? "Старый вариант с чередующимися цветными плашками отключён, чтобы субтитры выглядели ровно. Перевела проект на бордовую плашку со сдвигом.\n\n" : "";
    await sendMessage(env, chatId, `${note}Выбери оформление:\n• Бордовая со сдвигом — цельная округлая плашка с одной выбранной прозрачностью.\n• Белый текст + тень — без общей плашки.\n• Жёлтое/розовое/красное слово — фраза белая, цветом подсвечивается только произносимое слово.\n• Тёмная прозрачная — ровная округлая плашка без сдвига.\n\nСейчас: ${styleById(session.style)?.label}. Прозрачность: /plate-opacity. Шрифт: /font.`, captionStyleKeyboard(session.style));
    return new Response("ok");
  }

  if (normalized === "/new" || normalized === "новый монтаж") {
    await saveSession(env, chatId, freshSession(session));
    await sendMessage(env, chatId, "Новый проект готов. Отправь исходное видео (до 20 МБ) или ссылку Dropbox/OneDrive. Можно несколько, затем напиши «собери». Стиль: /styles. Прозрачность плашки: /plate-opacity. Шрифт: /font. Положение: /caption-position. Движение: /motion. Скорость: /speed. Цвет: /filter. Референс камеры: /ref. Вставка: /insert или /findinsert тема. Плашка: /plate. Слои: /layers, /undo, /remove layer 2.");
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

  if (normalized === "/layers" || normalized === "слои" || normalized === "мои слои") {
    const layers = [
      ...(session?.inserts || []).map((item, index) => ({ type: "вставка", index: index + 1, item, createdAt: item.createdAt || 0 })),
      ...(session?.plates || []).map((item, index) => ({ type: "плашка", index: index + 1, item, createdAt: item.createdAt || 0 })),
    ].sort((a, b) => a.createdAt - b.createdAt);
    if (!layers.length) await sendMessage(env, chatId, "Пока слоёв нет. Их можно добавить командами «вставка» и «плашка» до сборки ролика.");
    else await sendMessage(env, chatId, `Слои текущего проекта (пока ролик ещё не собран):\n${layers.map((layer, i) => {
      const detail = layer.type === "вставка" ? describeInsert(layer.item) : `«${layer.item.text}», с ${layer.item.at} сек на ${layer.item.dur} сек`;
      return `${i + 1}. ${layer.type} ${layer.index}: ${detail}`;
    }).join("\n")}\n\nУбрать последний слой: /undo. Убрать по номеру: /remove layer 2.`);
    return new Response("ok");
  }

  if (normalized === "/undo" || normalized === "отмени слой" || normalized === "отменить последний слой") {
    session ||= freshSession();
    const candidates = [
      ...(session.inserts || []).map((item, index) => ({ type: "insert", index, createdAt: item.createdAt || 0 })),
      ...(session.plates || []).map((item, index) => ({ type: "plate", index, createdAt: item.createdAt || 0 })),
    ].sort((a, b) => a.createdAt - b.createdAt);
    const last = candidates[candidates.length - 1];
    if (!last) await sendMessage(env, chatId, "В текущем проекте пока нечего отменять.");
    else {
      const removed = last.type === "insert" ? session.inserts.splice(last.index, 1)[0] : session.plates.splice(last.index, 1)[0];
      await saveSession(env, chatId, session);
      await sendMessage(env, chatId, `Убрала последний слой (${last.type === "insert" ? "вставку" : "плашку"}${removed?.text ? ` «${removed.text}»` : ""}).`);
    }
    return new Response("ok");
  }

  const removeLayer = text.match(/^\/remove(?:@\w+)?\s+layer\s+(\d+)$/i);
  const removeTypedLayer = text.match(/^\/remove(?:@\w+)?\s+(insert|вставку|plate|плашку)\s+(\d+)$/i);
  if (removeLayer || removeTypedLayer) {
    session ||= freshSession();
    const inserts = session.inserts || [];
    const plates = session.plates || [];
    if (removeTypedLayer) {
      const isInsert = /insert|вставку/i.test(removeTypedLayer[1]);
      const list = isInsert ? inserts : plates;
      const index = Number(removeTypedLayer[2]) - 1;
      if (index < 0 || index >= list.length) await sendMessage(env, chatId, "Не нашла такой номер. Проверь список командой /layers.");
      else {
        const [removed] = list.splice(index, 1);
        await saveSession(env, chatId, session);
        await sendMessage(env, chatId, `Убрала слой: ${isInsert ? "вставка" : "плашка"}${removed?.text ? ` «${removed.text}»` : ""}.`);
      }
    } else {
      const layers = [
        ...inserts.map((item, index) => ({ type: "insert", index, createdAt: item.createdAt || 0 })),
        ...plates.map((item, index) => ({ type: "plate", index, createdAt: item.createdAt || 0 })),
      ].sort((a, b) => a.createdAt - b.createdAt);
      const layer = layers[Number(removeLayer[1]) - 1];
      if (!layer) await sendMessage(env, chatId, "Не нашла такой номер. Проверь список командой /layers.");
      else {
        const removed = layer.type === "insert" ? inserts.splice(layer.index, 1)[0] : plates.splice(layer.index, 1)[0];
        await saveSession(env, chatId, session);
        await sendMessage(env, chatId, `Убрала слой №${removeLayer[1]} (${layer.type === "insert" ? "вставка" : "плашка"}${removed?.text ? ` «${removed.text}»` : ""}).`);
      }
    }
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
    session.plates.push({ ...plate, id: crypto.randomUUID(), createdAt: Date.now() });
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
      const item = { url: link.replace(/[.,;]+$/, ""), name: /\.gif(\?|$)/i.test(link) ? "insert.gif" : "insert.mp4", kind: /\.gif(\?|$)|giphy|tenor/i.test(link) ? "gif" : "video", ...args, id: crypto.randomUUID(), createdAt: Date.now() };
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
      const item = { ...base, ...args, id: crypto.randomUUID(), createdAt: Date.now() };
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
    session.style = normalizeStyleId(session.style);
    session.plateOpacity = PLATE_OPACITY_OPTIONS.includes(Number(session.plateOpacity)) ? Number(session.plateOpacity) : DEFAULT_PLATE_OPACITY;
    session.captionFont = Object.hasOwn(CAPTION_FONTS, session.captionFont) ? session.captionFont : DEFAULT_CAPTION_FONT;
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
      await sendMessage(env, chatId, `Видео принято (${session.sources.length}/${MAX_SOURCES}). Выбери стиль субтитров или отправь ещё видео. Прозрачность плашки: /plate-opacity; шрифт: /font. Когда всё готово, напиши «собери».`, captionStyleKeyboard(session.style));
    }
    return new Response("ok");
  }

  if (["собери", "собрать", "/render", "/собери"].includes(normalized)) {
    if (!session?.sources?.length) {
      await sendMessage(env, chatId, "Сначала отправь /new и хотя бы одно видео или ссылку.");
      return new Response("ok");
    }
    const id = `RB-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const style = normalizeStyleId(session.style);
    const plateOpacity = PLATE_OPACITY_OPTIONS.includes(Number(session.plateOpacity)) ? Number(session.plateOpacity) : DEFAULT_PLATE_OPACITY;
    const captionFont = Object.hasOwn(CAPTION_FONTS, session.captionFont) ? session.captionFont : DEFAULT_CAPTION_FONT;
    const job = { id, chatId, sources: session.sources, reference: session.reference || null, inserts: session.inserts || [], plates: session.plates || [], style, plateOpacity, captionFont, captionPosition: session.captionPosition || "auto", cameraMode: session.cameraMode || "standard", speed: session.speed || 1, colorFilter: session.colorFilter || "original", captionEdits: session.captionEdits || [], revisionOf: session.editingJobId || null, status: "queued", createdAt: Date.now(), attempts: 0 };
    await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
    await env.STATE.put(sessionKey, JSON.stringify({ ...freshSession(session) }), { expirationTtl: SESSION_TTL });
    await sendMessage(env, chatId, `Задача ${id} сохранена${job.revisionOf ? ` как обновление ${job.revisionOf}` : ""}. Стиль: ${styleById(style)?.label}; шрифт: ${CAPTION_FONTS[captionFont]}; заливка плашки: ${plateOpacity}%.${job.reference ? " Зум возьму из референса." : ""}${job.inserts.length ? ` Вставок: ${job.inserts.length}.` : ""}${job.plates.length ? ` Плашек: ${job.plates.length}.` : ""}${job.captionEdits.length ? ` Исправлений субтитров: ${job.captionEdits.length}.` : ""} Монтаж стартует в течение нескольких минут, готовый ролик пришлю сюда. Статус: /queue.`);
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
      await sendMessage(env, job.chatId, job.kind === "creative"
        ? `Готово — ${job.id}. Варианты хуков и сценарий отправлены выше.`
        : `Готово — ${job.id}. Ролик смонтирован, субтитры добавлены, звук нормализован.`);
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
