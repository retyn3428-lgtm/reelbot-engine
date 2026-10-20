type TelegramChat = { id: number };

type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
};

type TelegramVideo = {
  file_id: string;
  file_name?: string;
  duration?: number;
  mime_type?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  video?: TelegramVideo;
  document?: TelegramDocument;
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type Session = {
  stage: "idle" | "awaiting_reference" | "awaiting_sources" | "ready";
  reference?: { fileId: string; name: string };
  sources: Array<{ fileId: string; name: string }>;
  createdAt: number;
};

type QueueJob = {
  id: string;
  chatId: number;
  sourceCount: number;
  hasReference: boolean;
  status: "queued" | "analyzing" | "ready";
  createdAt: number;
};

const sessions = new Map<number, Session>();
const queue: QueueJob[] = [];

function getToken() {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

function getSession(chatId: number): Session {
  const existing = sessions.get(chatId);
  if (existing) return existing;
  const fresh: Session = { stage: "idle", sources: [], createdAt: Date.now() };
  sessions.set(chatId, fresh);
  return fresh;
}

function keyboard(rows: Array<Array<{ text: string; callback_data: string }>>) {
  return { inline_keyboard: rows };
}

async function telegramApi<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = getToken();
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN is not configured");
    return null;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !payload.ok) {
    console.error(`[Telegram] ${method} failed: ${payload.description ?? response.statusText}`);
    return null;
  }
  return payload.result ?? null;
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: ReturnType<typeof keyboard>,
) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(id: string) {
  await telegramApi("answerCallbackQuery", { callback_query_id: id });
}

function fileFromMessage(message: TelegramMessage) {
  if (message.video) {
    return { fileId: message.video.file_id, name: message.video.file_name ?? "video.mp4" };
  }
  if (message.document && message.document.mime_type?.startsWith("video/")) {
    return { fileId: message.document.file_id, name: message.document.file_name ?? "video.mp4" };
  }
  return null;
}

function startKeyboard() {
  return keyboard([
    [{ text: "Новый монтаж", callback_data: "new_project" }],
    [
      { text: "Моя очередь", callback_data: "queue" },
      { text: "Как это работает", callback_data: "help" },
    ],
  ]);
}

function referenceKeyboard() {
  return keyboard([
    [{ text: "Добавить референс", callback_data: "reference" }],
    [{ text: "Без референса", callback_data: "skip_reference" }],
  ]);
}

function sourceKeyboard() {
  return keyboard([
    [{ text: "Добавить ещё видео", callback_data: "more_sources" }],
    [{ text: "Собрать превью", callback_data: "render_preview" }],
    [{ text: "Отменить проект", callback_data: "cancel_project" }],
  ]);
}

function newSession(chatId: number, stage: Session["stage"]): Session {
  const session: Session = { stage, sources: [], createdAt: Date.now() };
  sessions.set(chatId, session);
  return session;
}

async function showQueue(chatId: number) {
  const ownJobs = queue.filter((job) => job.chatId === chatId).slice(-5).reverse();
  if (ownJobs.length === 0) {
    await sendTelegramMessage(chatId, "Очередь пока пустая. Нажми «Новый монтаж», чтобы начать.", startKeyboard());
    return;
  }
  const lines = ownJobs.map((job) => {
    const status = job.status === "queued" ? "ожидает обработки" : job.status === "analyzing" ? "анализ материалов" : "превью готово";
    return `• ${job.id} — ${status} · ${job.sourceCount} исходн.`;
  });
  await sendTelegramMessage(chatId, `Твоя очередь:\n\n${lines.join("\n")}\n\nПолный рендер подключим следующим шагом.`, startKeyboard());
}

async function enqueuePreview(chatId: number) {
  const session = getSession(chatId);
  if (session.sources.length === 0) {
    await sendTelegramMessage(chatId, "Сначала пришли хотя бы одно исходное видео — без него монтаж не собрать.", sourceKeyboard());
    return;
  }
  const job: QueueJob = {
    id: `RB-${String(queue.length + 1).padStart(3, "0")}`,
    chatId,
    sourceCount: session.sources.length,
    hasReference: Boolean(session.reference),
    status: "queued",
    createdAt: Date.now(),
  };
  queue.push(job);
  session.stage = "ready";
  await sendTelegramMessage(
    chatId,
    `Проект ${job.id} принят в очередь.\n\nМатериалы: ${job.sourceCount} видео${job.hasReference ? " + референс" : ""}.\nСледом применим: очистку пауз, расшифровку, выбранные субтитры, зум и цветокоррекцию.`,
    startKeyboard(),
  );
}

async function handleCallback(query: TelegramCallbackQuery) {
  await answerCallback(query.id);
  const chatId = query.message?.chat.id;
  if (!chatId) return;
  switch (query.data) {
    case "new_project":
      newSession(chatId, "awaiting_reference");
      await sendTelegramMessage(chatId, "Начинаем новый монтаж. Сначала пришли видео-референс стиля или выбери «Без референса».", referenceKeyboard());
      return;
    case "reference":
      getSession(chatId).stage = "awaiting_reference";
      await sendTelegramMessage(chatId, "Хорошо. Пришли видео, с которого нужно взять стиль субтитров, зум или цветокоррекцию.");
      return;
    case "skip_reference":
      newSession(chatId, "awaiting_sources");
      await sendTelegramMessage(chatId, "Референс пропускаем. Теперь пришли одно или несколько своих исходных видео.", sourceKeyboard());
      return;
    case "more_sources":
      getSession(chatId).stage = "awaiting_sources";
      await sendTelegramMessage(chatId, "Пришли следующий исходник. Можно отправить несколько видео подряд.");
      return;
    case "render_preview":
      await enqueuePreview(chatId);
      return;
    case "cancel_project":
      newSession(chatId, "idle");
      await sendTelegramMessage(chatId, "Проект отменён. Материалы этого черновика больше не используются.", startKeyboard());
      return;
    case "queue":
      await showQueue(chatId);
      return;
    case "help":
      await sendTelegramMessage(chatId, "Сценарий ReelBot:\n1. Пришли референс, если хочешь повторить его стиль.\n2. Пришли свои исходники.\n3. Нажми «Собрать превью».\n\nДальше добавим выбор субтитров, стекла, всех зумов, цвета и сохранение результата в OneDrive.", startKeyboard());
      return;
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim().toLowerCase();

  if (text === "/start" || text === "/help") {
    newSession(chatId, "idle");
    await sendTelegramMessage(chatId, "Привет! Я ReelBot — облачный помощник для монтажа. Пришли референс, исходники и получи монтажный проект без установки программ.", startKeyboard());
    return;
  }
  if (text === "/queue" || text.includes("очеред")) {
    await showQueue(chatId);
    return;
  }
  if (text.includes("новый монтаж") || text === "/new") {
    newSession(chatId, "awaiting_reference");
    await sendTelegramMessage(chatId, "Начинаем новый монтаж. Сначала пришли референс стиля или выбери «Без референса».", referenceKeyboard());
    return;
  }
  if (text.includes("без референса") || text.includes("пропустить")) {
    newSession(chatId, "awaiting_sources");
    await sendTelegramMessage(chatId, "Референс пропускаем. Теперь пришли свои исходные видео.", sourceKeyboard());
    return;
  }

  const file = fileFromMessage(message);
  if (file) {
    const session = getSession(chatId);
    if (session.stage === "awaiting_reference") {
      session.reference = file;
      session.stage = "awaiting_sources";
      await sendTelegramMessage(chatId, `Референс принят: ${file.name}. Теперь пришли исходные дубли — можно несколько подряд.`, sourceKeyboard());
      return;
    }
    if (session.stage === "awaiting_sources" || session.stage === "ready") {
      session.sources.push(file);
      session.stage = "awaiting_sources";
      await sendTelegramMessage(chatId, `Исходник принят: ${file.name}. Всего исходников: ${session.sources.length}.`, sourceKeyboard());
      return;
    }
    await sendTelegramMessage(chatId, "Я получил видео. Нажми «Новый монтаж», чтобы выбрать: это референс или исходник.", startKeyboard());
    return;
  }

  await sendTelegramMessage(chatId, "Выбери действие кнопками ниже — так я не потеряю порядок референса и исходников.", startKeyboard());
}

export async function getTelegramBotInfo() {
  return telegramApi<{ id: number; is_bot: boolean; first_name: string; username?: string }>("getMe", {});
}

export async function setTelegramWebhook(webhookUrl: string) {
  return telegramApi<boolean>("setWebhook", { url: webhookUrl, drop_pending_updates: false });
}

export function telegramIsConfigured() {
  return Boolean(getToken());
}
