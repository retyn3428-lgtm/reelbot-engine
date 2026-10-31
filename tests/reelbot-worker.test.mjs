import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare/reelbot-gateway.js";

function makeEnv(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    ALLOWED_TELEGRAM_USER_ID: "42",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    STATE: {
      async get(key, type) {
        const value = data.get(key);
        if (value == null) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) { data.set(key, value); },
      async list({ prefix }) { return { keys: [...data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }; },
    },
    data,
  };
}

async function sendUpdate(env, update) {
  return worker.fetch(new Request("https://reelbot.test/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-webhook-secret" },
    body: JSON.stringify(update),
  }), env);
}

test("/script puts a creative request in the worker queue", async () => {
  const env = makeEnv();
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/script как показать пользу SPF для жирной кожи" } });
    const jobs = [...env.data.entries()].filter(([key]) => key.startsWith("job:")).map(([, value]) => JSON.parse(value));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, "creative");
    assert.match(jobs[0].request, /SPF/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /не копирует чужие формулировки/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("/caption-position offers automatic, top and bottom modes", async () => {
  const env = makeEnv();
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/caption-position" } });
    assert.deepEqual(sent[0].reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
      "caption-position:auto", "caption-position:bottom", "caption-position:top",
    ]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("/remove layer deletes only the selected pending insert layer", async () => {
  const env = makeEnv({
    "session:42": JSON.stringify({
      sources: [{ fileId: "source" }],
      inserts: [{ name: "one.mp4", kind: "video", createdAt: 1 }, { name: "two.mp4", kind: "video", createdAt: 2 }],
      plates: [{ text: "Заголовок", at: 1, dur: 2, createdAt: 3 }],
      style: "shifted", captionPosition: "auto",
    }),
  });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/remove insert 1" } });
    const session = JSON.parse(env.data.get("session:42"));
    assert.deepEqual(session.inserts.map((item) => item.name), ["two.mp4"]);
    assert.equal(session.plates.length, 1);
    assert.equal(session.sources.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});


test("/findinsert offers only small GIF/video with an allowed license and stores attribution", async () => {
  const env = makeEnv();
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://commons.wikimedia.org/w/api.php")) {
      assert.match(init.headers["Api-User-Agent"], /reelbot-engine/);
      return new Response(JSON.stringify({ query: { pages: [
        { title: "File:Good clip.mp4", imageinfo: [{ url: "https://upload.wikimedia.org/good.mp4", descriptionurl: "https://commons.wikimedia.org/wiki/File:Good_clip.mp4", mime: "video/mp4", size: 1024, extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" }, Artist: { value: "<a>Jane Doe</a>" } } }] },
        { title: "File:Restricted clip.mp4", imageinfo: [{ url: "https://upload.wikimedia.org/restricted.mp4", mime: "video/mp4", size: 1024, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" }, Artist: { value: "Uploader" } } }] },
        { title: "File:Too large.gif", imageinfo: [{ url: "https://upload.wikimedia.org/large.gif", mime: "image/gif", size: 30 * 1024 * 1024, extmetadata: { LicenseShortName: { value: "CC0" } } }] },
      ] } }));
    }
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/findinsert surprised reaction" } });
    const session = JSON.parse(env.data.get("session:42"));
    assert.equal(session.mediaCandidates.length, 1);
    assert.equal(session.mediaCandidates[0].title, "Good clip.mp4");
    assert.equal(session.mediaCandidates[0].artist, "Jane Doe");
    assert.equal(session.mediaCandidates[0].license, "CC BY 4.0");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /CC BY 4\.0/);

    await sendUpdate(env, { callback_query: { id: "cb1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "media-add:0" } });
    const updated = JSON.parse(env.data.get("session:42"));
    assert.equal(updated.inserts.length, 1);
    assert.equal(updated.inserts[0].kind, "video");
    assert.equal(updated.inserts[0].artist, "Jane Doe");
    assert.match(updated.inserts[0].attribution, /CC BY 4\.0/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("/edit reopens an owned finished job and /caption-edit changes one timestamp", async () => {
  const env = makeEnv({
    "job:RB-OLD-1": JSON.stringify({
      id: "RB-OLD-1", chatId: 42, status: "ready", kind: "video",
      sources: [{ fileId: "source" }], inserts: [{ name: "meme.mp4", kind: "video", createdAt: 1 }],
      plates: [], style: "shifted", captionPosition: "auto", captionEdits: [],
    }),
  });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/edit RB-OLD-1" } });
    let session = JSON.parse(env.data.get("session:42"));
    assert.equal(session.editingJobId, "RB-OLD-1");
    assert.equal(session.inserts.length, 1);
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/caption-edit 12 Правильный текст" } });
    session = JSON.parse(env.data.get("session:42"));
    assert.deepEqual(session.captionEdits, [{ at: 12, text: "Правильный текст", createdAt: session.captionEdits[0].createdAt }]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});


test("camera, speed and filter selections are stored in a new edit job", async () => {
  const env = makeEnv();
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/motion" } });
    await sendUpdate(env, { callback_query: { id: "m1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "camera-mode:none" } });
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/speed" } });
    await sendUpdate(env, { callback_query: { id: "s1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "speed:1.2" } });
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "/filter" } });
    await sendUpdate(env, { callback_query: { id: "f1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "filter:warm" } });
    const session = JSON.parse(env.data.get("session:42"));
    session.sources = [{ fileId: "source" }];
    env.data.set("session:42", JSON.stringify(session));
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "собери" } });
    const job = [...env.data.entries()].filter(([key]) => key.startsWith("job:")).map(([, value]) => JSON.parse(value))[0];
    assert.equal(job.cameraMode, "none");
    assert.equal(job.speed, 1.2);
    assert.equal(job.colorFilter, "warm");
    assert.equal(sent[0].reply_markup.inline_keyboard.flat().length, 3);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("caption style, font and plate opacity reach the queued render job", async () => {
  const env = makeEnv();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  try {
    await sendUpdate(env, { callback_query: { id: "st1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "style:karaoke_pink" } });
    await sendUpdate(env, { callback_query: { id: "op1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "plate-opacity:40" } });
    await sendUpdate(env, { callback_query: { id: "fo1", from: { id: 42 }, message: { chat: { id: 42 } }, data: "caption-font:oswald" } });
    const session = JSON.parse(env.data.get("session:42"));
    session.sources = [{ fileId: "source" }];
    env.data.set("session:42", JSON.stringify(session));
    await sendUpdate(env, { message: { from: { id: 42 }, chat: { id: 42 }, text: "собери" } });
    const job = [...env.data.entries()].filter(([key]) => key.startsWith("job:")).map(([, value]) => JSON.parse(value))[0];
    assert.equal(job.style, "karaoke_pink");
    assert.equal(job.plateOpacity, 40);
    assert.equal(job.captionFont, "oswald");
  } finally {
    globalThis.fetch = oldFetch;
  }
});
