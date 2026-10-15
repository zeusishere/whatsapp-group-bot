# WhatsApp Group Agent

An autonomous WhatsApp group agent with group memory and (later) grounded web browsing.

This repository is built incrementally. **Step 1 (current)** is the foundation: a NestJS service that links a
dedicated WhatsApp number through [Baileys](https://github.com/WhiskeySockets/Baileys), passively stores group
messages in SQLite, and exposes a REST API to connect, disconnect, inspect and send messages.

## Why Baileys

The official WhatsApp Cloud / Business API cannot be added to ordinary consumer groups and does not stream group
conversations. The bot therefore runs as a **linked device** (WhatsApp Multi-Device protocol) of a dedicated
number, authenticated once with a QR code. Session keys are persisted to disk (`auth_info_baileys/`).

> **Risk:** this is an unofficial protocol and can violate WhatsApp's terms. Use an isolated secondary number
> (never your primary account), only respond when explicitly mentioned, and keep outbound volume low.

## Tech stack

- Node.js >= 20 (developed on 22), TypeScript, ESM
- NestJS 12 (`@nestjs/common`, `core`, `config`, `swagger`)
- `@whiskeysockets/baileys` for the WhatsApp transport
- `better-sqlite3` in WAL mode for storage
- pnpm

## Getting started

```bash
pnpm install
cp env.example.json env.json      # then edit env.json (at least change apiKey)
pnpm start:dev
```

Swagger UI: <http://localhost:3000/docs>. All endpoints live under `/api` and require an `x-api-key` header that
matches `apiKey` in `env.json`.

### Linking the bot to WhatsApp

```bash
export KEY=change-me   # your apiKey

# 1. start the session; a QR appears in the terminal (and at GET /api/whatsapp/qr)
curl -X POST localhost:3000/api/whatsapp/connect -H "x-api-key: $KEY"

# 2. on the bot's phone: WhatsApp > Linked devices > Link a device, scan the QR

# 3. confirm
curl localhost:3000/api/whatsapp/status -H "x-api-key: $KEY"      # state: "connected"

# 4. add the bot number to a group, send a message, then read what was stored
curl "localhost:3000/api/messages?limit=20" -H "x-api-key: $KEY"
```

To see the QR as an image, open the `dataUrl` returned by `GET /api/whatsapp/qr` in a browser.
After the first link, set `whatsapp.autoConnectOnBoot` to `true` to reconnect automatically on restart.

## Configuration (`env.json`)

`env.json` is gitignored. `env.example.json` is the committed template. Set `ENV_JSON_PATH` to load a different
file. The file is validated at startup and the app refuses to boot on invalid values.

| Key | Default | Description |
| --- | --- | --- |
| `app.port` | `3000` | HTTP port |
| `app.logLevel` | `info` | pino level for Baileys (`fatal` ... `trace`, `silent`) |
| `whatsapp.authDir` | `./auth_info_baileys` | Where session credentials are stored. Treat like a password |
| `whatsapp.botName` | `Bot` | Name used for `@BotName` matching in later steps |
| `whatsapp.autoConnectOnBoot` | `false` | Connect automatically when the app starts |
| `whatsapp.printQrInTerminal` | `true` | Print the QR in the terminal |
| `whatsapp.reconnect.baseDelayMs` | `1000` | First reconnect delay (doubles each attempt, with jitter) |
| `whatsapp.reconnect.maxDelayMs` | `60000` | Reconnect delay ceiling |
| `database.path` | `./data/bot.db` | SQLite file |
| `database.maxMessagesPerGroup` | `3000` | Retention cap per group |
| `apiKey` | `change-me` | Value expected in the `x-api-key` header |

## API

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/whatsapp/connect` | Start the session (idempotent) |
| POST | `/api/whatsapp/disconnect` | Close the socket, keep credentials |
| POST | `/api/whatsapp/logout` | Log out the device and wipe the stored session |
| GET | `/api/whatsapp/status` | State (`disconnected`, `connecting`, `qr_pending`, `connected`), bot JID, reconnect info |
| GET | `/api/whatsapp/qr` | Current QR (raw string and PNG data URL), 404 when none |
| GET | `/api/whatsapp/groups` | Groups the bot is in (must be connected) |
| POST | `/api/whatsapp/send` | Send text: `{ "jid", "text", "quotedMessageId?" }` |
| GET | `/api/messages` | Stored messages, newest first. Query: `groupId`, `limit` (1-500), `before` (epoch ms) |
| GET | `/api/messages/groups` | Groups with stored messages and counts |

## Behavior notes

- **Passive ingestion:** only group chats (`@g.us`) with text or extended text are stored. The bot never replies on
  its own in this step.
- **Reconnects:** unexpected disconnects trigger exponential backoff with jitter and never stop the process. A
  manual disconnect, or being logged out from the phone, stops reconnecting.
- **Storage:** SQLite runs in WAL mode; each group is trimmed to the latest `maxMessagesPerGroup` messages.

## Project layout

```
src/
  main.ts                 bootstrap, validation pipe, Swagger
  app.module.ts
  config/                 env.json loader and validation
  common/api-key.guard.ts x-api-key guard
  database/               better-sqlite3 service (WAL, schema)
  messages/               repository + read API
  whatsapp/               Baileys service, controller, message extractor
env.example.json          config template
```

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm start:dev` | Run with file watching |
| `pnpm build` / `pnpm start:prod` | Compile and run `dist/` |
| `pnpm test` | Unit tests |
| `pnpm lint` | ESLint |

## Roadmap

1. **Foundation (this step):** project setup, Baileys connection API, message storage.
2. Mention detection (`@BotName`, `mentionedJid`), quoted-message capture, typing presence, rate limiting.
3. Context retrieval (sliding window, quoted lookup, token budget) and `query_logs` audit table.
4. LLM answering pipeline with Tavily search and Jina Reader page fetch, plus plaintext citations.
5. Offline evaluation harness.
