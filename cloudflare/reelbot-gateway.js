const ALLOWED_USER_ID = "[OWNER_ID_REDACTED]";
async function telegram(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Telegram API error " + r.status);
  return r.json();
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", service: "reelbot-gateway", protected: true }), { headers: { "content-type": "application/json" } });
  if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found", { status: 404 });
  const update = await request.json();
  const message = update.message || (update.callback_query && update.callback_query.message);
  const userId = String((update.message && update.message.from && update.message.from.id) || (update.callback_query && update.callback_query.from && update.callback_query.from.id) || "");
  if (userId !== ALLOWED_USER_ID) {
    if (message && message.chat && message.chat.id && env.TELEGRAM_BOT_TOKEN) await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Этот бот закрытый." });
    return new Response("ok");
  }
  if (message && message.chat && message.chat.id && env.TELEGRAM_BOT_TOKEN) {
    const text = ((update.message && update.message.text) || "").trim();
    const reply = text === "/start" ? "ReelBot подключён. Закрытый шлюз работает; монтажный runner будет подключён следующим шагом." : "Сообщение принято. Worker работает, монтажный runner подключается.";
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: reply });
  }
  return new Response("ok");
}
addEventListener("fetch", event => event.respondWith(handle(event.request, globalThis)));
