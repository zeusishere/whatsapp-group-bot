# WhatsApp Group Agent

An autonomous WhatsApp group agent with group memory and (later) grounded web browsing.

This repository is built incrementally. **Step 1 (current)** is the foundation: a NestJS service that links a
dedicated WhatsApp number through [Baileys](https://github.com/WhiskeySockets/Baileys), passively stores group
messages in SQLite, and exposes a JWT-protected REST API to manage devices, inspect and send messages.

## Why Baileys

The official WhatsApp Cloud / Business API cannot be added to ordinary consumer groups and does not stream group
conversations. The bot therefore runs as a **linked device** (WhatsApp Multi-Device protocol) of a dedicated
number, authenticated once with a QR code. Any number of devices can be linked; each one is a *session* whose
credentials are persisted in SQLite.

> **Risk:** this is an unofficial protocol and can violate WhatsApp's terms. Use an isolated secondary number
> (never your primary account), only respond when explicitly mentioned, and keep outbound volume low.

## Tech stack

- Node.js >= 20 (developed on 22), TypeScript, ESM
- NestJS 12 (`@nestjs/common`, `core`, `config`, `swagger`)
- `@whiskeysockets/baileys` for the WhatsApp transport
- `better-sqlite3` in WAL mode for storage (messages, users, sessions and WhatsApp credentials)
- `@nestjs/jwt` for authentication
- pnpm

## Getting started

```bash
pnpm install
cp env.example.json env.json      # then set auth.jwtSecret (e.g. `openssl rand -hex 32`)
pnpm start:dev
```

Swagger UI: <http://localhost:3000/docs> (use **Authorize** with a JWT). All endpoints live under `/api`.

### Authentication (JWT)

Every route except `POST /api/auth/register` and `POST /api/auth/login` needs `Authorization: Bearer <token>`.

- The **first** user to register becomes `admin`. After that, self-registration is rejected unless
  `auth.allowRegistration` is `true`; admins create users with `POST /api/auth/users`.
- Tokens are HS256, signed with `auth.jwtSecret`, and expire after `auth.tokenTtlSeconds`. The guard re-reads the
  user on each request, so deleting a user or changing a role takes effect immediately.
- Users only see and control their own sessions (other users' ids return 404). Admins see all.

### Linking a WhatsApp device

```bash
B=localhost:3000/api

# 1. create the first (admin) account and keep the token
TOKEN=$(curl -s $B/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-password"}' | jq -r .accessToken)
AUTH="authorization: Bearer $TOKEN"

# 2. create a session (one per device) and start it
ID=$(curl -s -X POST $B/sessions -H "$AUTH" -H 'content-type: application/json' -d '{"label":"Support"}' | jq -r .id)
# connect waits up to 15s and returns the QR (qr + qrDataUrl) when the device is not linked yet
curl -X POST $B/sessions/$ID/connect -H "$AUTH"

# 3. open qrDataUrl in a browser and scan it: WhatsApp > Linked devices > Link a device
#    (the QR rotates; GET /sessions/$ID/qr returns the current one)
curl $B/sessions/$ID/qr -H "$AUTH"

# 4. confirm
curl $B/sessions/$ID -H "$AUTH"                       # state: "connected"

# 5. add the number to a group, send a message, read what was stored
curl "$B/sessions/$ID/messages?limit=20" -H "$AUTH"
```

Repeat step 2 for as many devices as you like (`whatsapp.maxSessionsPerUser`).

### Persistence and restarts

Credentials and Signal keys are stored in SQLite (`auth_creds` table), one set per session, so a restart needs no new
QR. Each session row has two fields:

- `status`: what is happening now (`disconnected`, `connecting`, `qr_pending`, `connected`, `logged_out`). It is
  updated on every connection event, and reset to `disconnected` at boot because no socket survives a restart.
- `desiredState`: what you asked for. `connect` sets `connected`; `disconnect`, `logout` and being logged out from
  the phone set `stopped`. On boot, every paired session with `desiredState = connected` is reconnected, one at a time
  (`whatsapp.restoreStaggerMs`). Stopping the app does **not** change `desiredState`.

`lastSeenAt` is refreshed every `whatsapp.heartbeatIntervalMs` while a session is connected, so after a crash it shows
roughly when the process died.

## Configuration (`env.json`)

`env.json` is gitignored. `env.example.json` is the committed template. Set `ENV_JSON_PATH` to load a different
file. The file is validated at startup and the app refuses to boot on invalid values.

| Key | Default | Description |
| --- | --- | --- |
| `app.port` | `3000` | HTTP port |
| `app.logLevel` | `info` | pino level for Baileys (`fatal` ... `trace`, `silent`) |
| `whatsapp.restoreOnBoot` | `true` | Reconnect sessions whose desired state is `connected` when the app starts |
| `whatsapp.restoreStaggerMs` | `1000` | Pause between restoring two sessions |
| `whatsapp.printQrInTerminal` | `false` | Also print each QR in the terminal |
| `whatsapp.maxSessionsPerUser` | `5` | Session cap per user |
| `whatsapp.heartbeatIntervalMs` | `30000` | How often `lastSeenAt` is refreshed for connected sessions |
| `whatsapp.reconnect.baseDelayMs` | `1000` | First reconnect delay (doubles each attempt, with jitter) |
| `whatsapp.reconnect.maxDelayMs` | `60000` | Reconnect delay ceiling |
| `database.path` | `./data/bot.db` | SQLite file (also holds WhatsApp credentials: treat like a password) |
| `database.maxMessagesPerGroup` | `3000` | Retention cap per group, per session |
| `auth.jwtSecret` | *required* | HS256 signing secret, at least 32 characters |
| `auth.tokenTtlSeconds` | `3600` | Access token lifetime |
| `auth.allowRegistration` | `false` | Allow self-registration after the first (admin) user |

## API

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/register` | Sign up (first user becomes admin; later gated by `auth.allowRegistration`) |
| POST | `/api/auth/login` | Email + password, returns a JWT |
| GET | `/api/auth/me` | The authenticated user |
| POST | `/api/auth/users` | Admin only: create a user (`role` optional) |
| POST | `/api/sessions` | Create a session `{ "label?" }` (does not connect) |
| GET | `/api/sessions` | Your sessions with live status (admins: all) |
| GET | `/api/sessions/:id` | Status: state, desired state, JID, reconnect info, `lastSeenAt` |
| POST | `/api/sessions/:id/connect` | Start the session (idempotent); restored on boot afterwards |
| POST | `/api/sessions/:id/disconnect` | Close the socket, keep credentials, stop restoring on boot |
| POST | `/api/sessions/:id/logout` | Log the device out and wipe its credentials |
| DELETE | `/api/sessions/:id` | Log out and delete the session, credentials and stored messages |
| GET | `/api/sessions/:id/qr` | Current QR (raw string and PNG data URL), 404 when none |
| GET | `/api/sessions/:id/groups` | Groups the device is in (must be connected) |
| POST | `/api/sessions/:id/send` | Send text: `{ "jid", "text", "quotedMessageId?" }` |
| GET | `/api/sessions/:id/messages` | Stored messages, newest first. Query: `groupId`, `limit` (1-500), `before` (epoch ms) |
| GET | `/api/sessions/:id/messages/groups` | Groups with stored messages and counts |

## Behavior notes

- **Passive ingestion:** only group chats (`@g.us`) with text or extended text are stored. The bot never replies on
  its own in this step.
- **Reconnects:** unexpected disconnects trigger exponential backoff with jitter and never stop the process. A
  manual disconnect, or being logged out from the phone (status `logged_out`, credentials wiped), stops reconnecting.
- **Storage:** SQLite runs in WAL mode; each group of each session is trimmed to the latest `maxMessagesPerGroup`.
- **Upgrading from the single-device version:** the `messages` table is migrated automatically and old rows are kept
  under session id `legacy` (not visible through the API). The old `auth_info_baileys/` folder is no longer read:
  create a session and scan the QR again, then delete the folder.
- **Not included:** login rate limiting, refresh tokens and at-rest encryption of the credentials. Put the API behind
  HTTPS and protect `data/` like a password store.

## Project layout

```
src/
  main.ts                 bootstrap, validation pipe, Swagger
  app.module.ts
  config/                 env.json loader and validation
  auth/                   users, password hashing, JWT guard, roles
  database/               better-sqlite3 service (WAL, schema, migrations)
  sessions/               sessions table repository (status, desired state, ownership)
  messages/               repository + read API (scoped per session)
  whatsapp/               session manager, per-device runtime, SQLite auth state, controller
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
