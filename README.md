# ReelBot — облачный монтаж видео

React / Express / tRPC / Drizzle starter, adapted from the Sandbox web-db-user template.

- `pnpm dev`: development server; honors `PORT` (default 3000).
- `pnpm build` / `pnpm start`: build and serve `dist/index.js` and `dist/public/`.
- `pnpm db:migrate`: apply checked-in migrations. `pnpm db:push`: generate and apply new schema changes.
- `pnpm check` / `pnpm test`: types and application tests.

Start with the Webdev skill's default-template guide. Platform login, storage, payments and service contracts live in its shared references; read the relevant capability before extending its helper.

`server/_core/publicConfig.ts` exposes only named public runtime values. Private keys stay server-side. The platform serves managed `/manus-storage/` assets; the application does not register a second proxy.

## Closed Telegram mode

The Telegram handler is fail-closed: it processes updates only when `ALLOWED_TELEGRAM_USER_ID` is set and matches the sender's numeric Telegram user ID. For this bot, the deployment must set `ALLOWED_TELEGRAM_USER_ID=[OWNER_ID_REDACTED]`. Keep `TELEGRAM_BOT_TOKEN` in the hosting provider's secret store; never commit it to this repository.

Platform configuration is readable and editable through `webdev.config`. Default settings are initial values, not enforced constraints. The agent may modify the files, commands and configuration or follow the flexible guide for another stack.
