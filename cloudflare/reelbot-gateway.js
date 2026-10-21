const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 49 * 1024 * 1024;
const SESSION_TTL = 24 * 60 * 60;
const JOB_TTL = 7 * 24 * 60 * 60;

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

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

function authorizedRunner(request, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const header = request.headers.get("authorization") || "";
  return Boolean(token && header === `Bearer ${token}`);
}

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

  const text = String(update.message?.text || "").trim();
  const normalized = text.toLowerCase();
  const sessionKey = `session:${chatId}`;
  let session = await env.STATE.get(sessionKey, "json");

  if (normalized === "/start" || normalized === "/help") {
    await sendMessage(env, chatId, "Привет! Я закрытый ReelBot. Отправь /new, затем одно или несколько видео (до 20 МБ каждое), потом напиши «собери». Я сделаю вертикальный ролик с русскими субтитрами, удалением длинных пауз и нормализацией звука.");
    return new Response("ok");
  }

  if (normalized === "/new" || normalized === "новый монтаж") {
    await env.STATE.put(sessionKey, JSON.stringify({ sources: [], createdAt: Date.now() }), { expirationTtl: SESSION_TTL });
    await sendMessage(env, chatId, "Новый проект готов. Отправь исходное видео (до 20 МБ). Можно прислать несколько, затем напиши «собери».");
    return new Response("ok");
  }

  if (normalized === "/queue" || normalized === "моя очередь") {
    const jobs = await getJobs(env, chatId);
    if (!jobs.length) await sendMessage(env, chatId, "Очередь пока пустая. Отправь /new, чтобы начать.");
    else await sendMessage(env, chatId, `Последние задачи:\n${jobs.map(j => `• ${j.id} — ${j.status === "queued" ? "ожидает запуска" : j.status === "processing" ? "монтируется" : j.status === "ready" ? "готово" : "ошибка"}`).join("\n")}`);
    return new Response("ok");
  }

  const source = isVideo(message);
  if (source) {
    if (Number(source.size || 0) > MAX_INPUT_BYTES) {
      await sendMessage(env, chatId, "Файл больше 20 МБ. Для этого бесплатного варианта пришли видео размером до 20 МБ.");
      return new Response("ok");
    }
    session ||= { sources: [], createdAt: Date.now() };
    session.sources ||= [];
    if (session.sources.length >= 5) {
      await sendMessage(env, chatId, "В одном проекте можно обработать не больше 5 исходных видео. Напиши «собери» или начни новый через /new.");
      return new Response("ok");
    }
    session.sources.push({ fileId: source.fileId, name: source.name });
    await env.STATE.put(sessionKey, JSON.stringify(session), { expirationTtl: SESSION_TTL });
    await sendMessage(env, chatId, `Видео принято (${session.sources.length}/5). Пришли ещё одно или напиши «собери».`);
    return new Response("ok");
  }

  if (["собери", "собрать", "/render", "/собери"].includes(normalized)) {
    if (!session?.sources?.length) {
      await sendMessage(env, chatId, "Сначала отправь /new и хотя бы одно видео.");
      return new Response("ok");
    }
    const id = `RB-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const job = { id, chatId, sources: session.sources, status: "queued", createdAt: Date.now(), attempts: 0 };
    await env.STATE.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
    await env.STATE.delete(sessionKey);
    await sendMessage(env, chatId, `Задача ${id} поставлена в очередь. Бесплатный монтажный runner заберёт её при ближайшем запуске; обычно это занимает несколько минут.`);
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
    const marker = await env.STATE.get("config:webhook-active", "json");
    if (!marker || Date.now() - marker.setAt > 12 * 60 * 60 * 1000) {
      const origin = new URL(request.url).origin;
      await telegram(env, "setWebhook", {
        url: `${origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
        allowed_updates: ["message"],
      });
      await env.STATE.put("config:webhook-active", JSON.stringify({ setAt: Date.now() }), { expirationTtl: 24 * 60 * 60 });
    }
    return json({ ok: true });
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
      return json({ status: "ok", service: "reelbot-gateway", storageConfigured: Boolean(env.STATE), privateBot: true });
    }
    try {
      if (url.pathname === "/telegram" && request.method === "POST") return await handleTelegram(request, env);
      if (url.pathname.startsWith("/runner/")) return await handleRunner(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Keep request bodies, identifiers, and credentials out of logs.
      console.error("[ReelBot] request failed", error instanceof Error ? error.message : "unknown error");
      return json({ error: "request_failed" }, 500);
    }
  },
};
