import { processRenderJob, type RenderJob } from "../server/telegram";

type JsonResponse<T> = { ok?: boolean; job?: T | null; error?: string };

const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const base = (process.env.REELBOT_GATEWAY_URL ?? "").replace(/\/$/, "");
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!base) throw new Error("REELBOT_GATEWAY_URL is required");

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let payload: JsonResponse<T> = {};
  try { payload = (await response.json()) as JsonResponse<T>; } catch { /* handled below */ }
  if (!response.ok) throw new Error(payload.error || `Gateway returned HTTP ${response.status}`);
  return payload as T;
}

// Ensure the Telegram webhook is configured through Cloudflare. The token never appears in logs.
await post("/runner/activate");
let processed = 0;
const maxJobsPerRun = 10;
while (processed < maxJobsPerRun) {
  const result = await post<{ job: RenderJob | null }>("/runner/next");
  const job = result.job;
  if (!job) {
    if (processed === 0) console.log("[runner] Idle: no render jobs are queued.");
    break;
  }
  processed += 1;
  console.log("[runner] A render job was claimed.");
  try {
    await processRenderJob(job);
    await post("/runner/complete", { jobId: job.id });
    console.log("[runner] Render job completed.");
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message.slice(0, 2500) : "unknown rendering error";
    try {
      await post("/runner/fail", {
        jobId: job.id,
        error: safeMessage,
        userMessage: "Возникла техническая ошибка при обработке. Исходники не удалены из чата — попробуй один файл до 20 МБ. Если ошибка повторится, напиши «собери» ещё раз после /new.",
      });
    } catch {
      // Keep private job details and credentials out of public GitHub Actions logs.
      console.error("[runner] Could not report the render failure to Telegram.");
    }
    console.error("[runner] Render job failed; details were not written to public logs.");
  }
}
console.log(`[runner] Finished batch: ${processed} job(s).`);
