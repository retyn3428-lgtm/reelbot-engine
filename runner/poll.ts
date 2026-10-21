import { handleTelegramUpdate } from "../server/telegram";

type Update = { update_id: number; [key: string]: unknown };
const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`;

async function call<T>(method: string, body: Record<string, unknown> = {}) {
  const response = await fetch(api(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = (await response.json()) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !payload.ok) throw new Error(`${method}: ${payload.description ?? response.statusText}`);
  return payload.result as T;
}

await call("deleteWebhook", { drop_pending_updates: false });
console.log("[runner] polling mode enabled");
let offset = 0;
const deadline = Date.now() + 4 * 60 * 1000;
while (Date.now() < deadline) {
  const updates = await call<Update[]>("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
  for (const update of updates) {
    offset = Math.max(offset, update.update_id + 1);
    await handleTelegramUpdate(update as never);
  }
}
console.log("[runner] polling window finished");
