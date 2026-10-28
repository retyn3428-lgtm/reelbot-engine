# ReelBot

Исходный код приватного Telegram-бота для сборки вертикальных Reels с русскими субтитрами. Веб-приложение проекта сохранено; рабочий Telegram-бот закрыт allowlist владельца.

## Активный процесс обработки

- `cloudflare/reelbot-gateway.js` — исходник Cloudflare Worker v4. Он принимает Telegram webhook, хранит состояние и очередь в KV `STATE`, защищает внутренние `/runner/*` маршруты токеном и проксирует загрузку исходников и отправку готового видео.
- `runner.py` — Python-runner, который GitHub Actions запускает по расписанию примерно каждые 5 минут и вручную через **Actions → ReelBot runner → Run workflow**. Он забирает задания у Worker, скачивает видео во временную папку runner, монтирует ролик и отправляет его в Telegram. Исходные видео и готовые ролики не сохраняются в репозитории или KV.
- `requirements.txt` — зависимости runner: Whisper, OpenCV, NumPy и requests.
- `.github/workflows/reelbot-runner.yml` — активный workflow. У него только разрешение `contents: read`; credentials checkout не сохраняются.

`runner/poll.ts` и `server/telegram.ts` — прежняя TypeScript-реализация обработчика. Активный Actions workflow больше её не запускает.

## Возможности

Runner поддерживает фразовые субтитры (не больше 9 слов, обычно 6–9, до двух строк), русский текст и пунктуацию Whisper без смыслового перефразирования; удаление длинных пауз; шесть стилей `glass`, `powder`, `fuchsia`, `olive`, `echo`, `mixed`; вставки GIF/видео, текстовые плашки и видеореференс для приближённого зума. Worker поддерживает команды `/new`, `/styles`, `/ref`, `/insert`/`вставка`, `/plate`/`плашка`, `/clear` и `/queue`.

Публичный Dropbox-референс `Screen_Recording_20261017_105516.mp4` использовался для оформления фраз: белый текст на тёмной подложке, обычно две строки, ориентировочно 2–3 секунды на показ. ASS-подложка `BorderStyle 3` прямоугольная и не воспроизводит скругление референса точно.

## Секреты и доступ

Не добавляйте в репозиторий значения токенов, Telegram ID, webhook-секреты, Telegram file IDs, видео или готовые ролики.

- Cloudflare Worker secrets: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`, `TELEGRAM_WEBHOOK_SECRET`; binding: `STATE`.
- GitHub Actions secrets: `TELEGRAM_BOT_TOKEN`; `GATEWAY_URL` — адрес Worker (если секрет не задан, workflow использует текущий публичный URL); `ANTHROPIC_API_KEY` — необязательный ключ для анализа хука.

Значения хранятся только у провайдера. Runner передаёт сообщения через защищённые Worker-маршруты; не добавляйте значения секретов в логи.

## Проверки и разработка

- `python -m py_compile runner.py` — синтаксис runner.
- `node --check cloudflare/reelbot-gateway.js` — синтаксис Worker.
- `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test` — веб-приложение.
- Для локального видеотеста нужны FFmpeg, зависимости из `requirements.txt` и модель faster-whisper.

GitHub Actions может запускаться с задержкой; интервал проверки не обещает мгновенный ответ. Стандартный лимит входного Telegram-видео — 20 МБ, а готовый ролик должен быть меньше 49 МБ.
