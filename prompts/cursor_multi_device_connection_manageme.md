# Multi-device connection management
_Exported on 10/18/2026 at 22:58:00 GMT+5:30 from Cursor (3.14.7)_

---

**User**

@src/whatsapp/whatsapp.controller.ts  @src/whatsapp/whatsapp.service.ts 
 AS of Now the service supports single device, i want to add the ability to connect multiple devices whose connection details should be persisted. can these persisted session details be used  to reconnect when the system starts ?
can we also maintain status whether the device is still connected? how do we update the status of session.
how do i handle authentication for these different sessions/users

---

**Cursor**

Short answers: yes to all three. Persisted sessions can reconnect on boot, you can keep a live status per session, and authentication is mostly a separate concern from WhatsApp pairing.

## Why the current service is single-device

`WhatsappService` is a singleton that holds one set of per-session fields: `sock`, `state`, `qr`, `botJid`, `reconnectAttempts` and the timers. The auth state comes from one fixed `authDir` through `useMultiFileAuthState`. Messages are keyed by `group_id` only, so two accounts' messages would mix.

The usual fix is to turn that class into a manager plus a per-session worker:

```
WhatsappService (manager)          ← Map<sessionId, SessionRuntime>
  └─ SessionRuntime (one per device) ← what your current class does today
       sock, state, qr, botJid, reconnect timer, manualStop, starting
```

Almost all of your existing logic (`doStartSocket`, `handleClose`, `scheduleReconnect`, `teardownSocket`) moves unchanged into `SessionRuntime`. It is constructed with `sessionId` and its own auth directory.

## 1. Persisting sessions and reconnecting on startup

Yes, this works. Baileys credentials are already persistent, so a restart doesn't need a new QR unless the phone revoked the link. You need two things.

**a) Per-session credentials.**
- **Simple option:** one directory per session, `auth_info_baileys/<sessionId>/`, with `useMultiFileAuthState(resolve(authRoot, sessionId))`.
- **Better option for many sessions:** write a small SQLite-backed auth state. It's about 60 lines implementing `creds` and `keys` get/set, using `initAuthCreds` and `BufferJSON` from Baileys. Credentials then live in your existing `bot.db`, so a session's credentials and its metadata are deleted in one transaction.
- Baileys itself warns that `useMultiFileAuthState` is inefficient for production, because it writes many small files. That's another reason to prefer the SQLite option.

**b) A `sessions` table** next to `messages` in `schema.sql.ts`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,         -- your own id, e.g. uuid
  owner_id           TEXT NOT NULL,            -- which user/tenant owns it
  label              TEXT,
  jid                TEXT,                     -- filled in after first 'open'
  lid                TEXT,
  status             TEXT NOT NULL,            -- see below
  desired_state      TEXT NOT NULL DEFAULT 'connected', -- 'connected' | 'stopped'
  last_disconnect_code INTEGER,
  last_connected_at  INTEGER,
  last_seen_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

`desired_state` is the field that matters for restarts. It is intent, separate from the observed `status`.
- `connect()` sets it to `connected`.
- `disconnect()` sets it to `stopped`.
- `logout()` sets it to `stopped` and wipes the creds.

**On boot,** the manager's `onModuleInit` does this:

```ts
async onModuleInit() {
  const rows = sessions.findAll({ desiredState: 'connected', hasCreds: true });
  // stagger to avoid a thundering herd / WhatsApp rate limits
  for (const row of rows) {
    await this.getOrCreate(row.id).connect();
    await sleep(500 + Math.random() * 1000);
  }
}
```

This replaces your global `autoConnectOnBoot` flag. Keep it as a master kill switch if you like. Sessions that were never paired (no creds) shouldn't be auto-started, because they would only sit in `qr_pending`.

## 2. Connection status and how to update it

Two layers are worth keeping.

**Live state** is the in-memory state machine you already have: `connecting`, `qr_pending`, `connected`, `disconnected`. It is the source of truth while the process runs.

**Persisted status** is a mirror of that state in the `sessions` table, so you can query it, see it after a restart, and filter in the UI. Don't write to the DB from scattered places. Add one `setState(next, extra?)` method on `SessionRuntime` that updates the field, logs, and persists, then call it everywhere you currently assign `this.state = ...`:

```ts
private setState(state: ConnectionState, extra: Partial<SessionRow> = {}) {
  if (this.state === state && !Object.keys(extra).length) return;
  this.state = state;
  this.repo.update(this.id, { status: state, updatedAt: Date.now(), ...extra });
}
```

Where status actually changes, all inside `connection.update`:

| Event | Update |
|---|---|
| `qr` received | `qr_pending` |
| `connection === 'open'` | `connected`, set `jid`, `lid`, `last_connected_at`, clear `last_disconnect_code` |
| `connection === 'close'`, will retry | `connecting`, set `last_disconnect_code` |
| close with `401` (loggedOut) | `logged_out` (a new terminal state), wipe creds, set `desired_state='stopped'` |
| manual `disconnect()` | `disconnected` |
| process shutdown | don't mark `disconnected`, or `desired_state` would be wrongly kept |

On that last row, in `onModuleDestroy` tear the sockets down without changing `desired_state`. Otherwise the next boot won't restore them. Your current `manualStop = true` in `onModuleDestroy` would need to stop short of persisting anything.

**"Is it still connected?"** The `close` event covers clean drops. It does not cover a half-dead socket, such as a network partition, where no event ever fires. Options:
- Rely on Baileys' own keep-alive. It ends the connection with `connectionLost` / `timedOut` when pings fail, which produces a `close` event. This is usually enough.
- Add a cheap heartbeat: a `@nestjs/schedule` interval every 30–60 seconds that updates `last_seen_at` for `connected` sessions. If any inbound event (`messages.upsert`, `presence`) hasn't been seen for a long time, log it as stale. Don't force-restart on silence alone, because a quiet account is normal.
- On boot, reset all `connected` / `connecting` rows to `disconnected` before the restore loop. Otherwise the DB shows stale "connected" values after a crash.

For pushing changes to clients, expose `GET /sessions/:id/status`. If you want live updates, add an SSE endpoint, or an `EventEmitter2` event such as `session.status.changed` that webhooks or a gateway can subscribe to.

## 3. Authentication for different sessions and users

There are two different things called "auth" here.

**WhatsApp auth (pairing)** is per session. It is the QR scan, or a pairing code via `sock.requestPairingCode(phoneNumber)`, which is handy for headless use. The result is the creds blob. Only the session's own runtime ever touches it, and it must never be returned from an API.

**API auth (who may control which session)** is where your static `ApiKeyGuard` falls short. A single shared `x-api-key` means everyone who has the key can control every session. Moving toward multi-user:

1. **Add `users` and `api_keys` tables**, or use JWT if you have a login flow.
   - Store only a SHA-256 hash of each API key.
   - `ApiKeyGuard` looks up the hash and attaches `req.user = { id, role }`.
   - Compare hashes with `timingSafeEqual`, as you already do.
2. **Make sessions owned.** Every session row has `owner_id`.
   - A session guard or service method loads the session and checks `session.ownerId === req.user.id`, or the user is an admin.
   - Return 404 rather than 403 for sessions the user doesn't own, so ids can't be probed.
3. **Scope the routes** by session:
   ```
   POST   /api/sessions                      create (returns id)
   GET    /api/sessions                      list mine
   POST   /api/sessions/:id/connect
   POST   /api/sessions/:id/disconnect
   POST   /api/sessions/:id/logout
   DELETE /api/sessions/:id                  logout + delete creds + row
   GET    /api/sessions/:id/status
   GET    /api/sessions/:id/qr
   GET    /api/sessions/:id/groups
   POST   /api/sessions/:id/send
   GET    /api/sessions/:id/messages?groupId=...
   ```
4. **Scope the data.** Add `session_id` to `messages` and change the primary key to `(session_id, group_id, id)`. Otherwise, two sessions in the same group collide on `INSERT OR IGNORE`, and one user could read another's messages. `findById`, `list`, `listGroups` and `trim` all need `session_id` in their `WHERE` clauses. `ingest()` passes the runtime's `sessionId`.
5. **Protect the secrets.** The creds blob can impersonate the WhatsApp account. Keep `data/` and `auth_info_baileys/` out of backups you don't trust and set file mode `0600`. Consider encrypting the creds column with a key from env.

## Things to watch out for

- **Session limits and bans.** Many Baileys sessions in one Node process cost memory, roughly tens of MB each. Stagger reconnects, as shown above, and cap the number of sessions per user.
- **Shared mutable `logger`.** One pino logger is fine, but use a child logger with `{ sessionId }` for traceable logs.
- **Duplicate runtimes.** Your `starting` promise guard prevents duplicate sockets for one session. Keep it per runtime, and use the manager's map as the single place that creates runtimes. Don't run two app instances against the same DB, because both would try to own the same sessions. If you scale out later, you'll need a lease column such as `owner_instance` and `lease_expires_at`.
- **Creating a session.** `POST /sessions` should insert the row and create the runtime, but not connect. The client then calls `connect` and polls `qr` or `status`.
- **Migration.** Your existing `auth_info_baileys` folder can become the first session. Create one `sessions` row and move the folder to `auth_info_baileys/<id>/`, or import it into the SQLite store.

If you switch to Agent mode, I can implement this. Before I start, two decisions matter:
1. File-based or SQLite-backed credential storage.
2. How you want users authenticated: per-user API keys or JWT.

---

**User**

1.USE SQLITE BACKED CREDENTIAL STORAGE
2. use jwt FOR AUTHENTICATION

---

**Cursor**

I'll start by exploring the rest of the codebase.

Starting with config.

Now the database schema and migration.

Now the messages repository, made session-scoped.

Now the auth module.

Build passes. Now tests for the new pieces.

Now an end-to-end smoke test on a copy of the existing database (this also exercises the migration).

The server stopped when the previous shell call ended. I'll relaunch it detached.

`pkill -f` matched its own shell. Retrying without it.

QR flow works. Next I'll check shutdown and restore: stop the server, inspect the DB, fake a "paired" credential, and restart.

Lint is clean. Last, I'll update the README to match.

Multi-device sessions are in, with credentials stored in SQLite and JWT auth on every route. I haven't committed anything.

I didn't scan a real QR, so a live link to an actual phone is untested. The build and lint pass, and the 21 unit tests pass. I also ran the app against a copy of your existing database and tried these cases:

- **Auth and ownership:** the first user became admin, and a wrong password, a bad token and a non-admin creating users were all rejected. A second user couldn't see the admin's session (404).
- **Pairing:** `connect` moved a session to `qr_pending` and `/qr` returned a QR.
- **Restore on boot:** I seeded a fake "paired" credential and restarted. The session was picked up from the database and WhatsApp rejected the fake credentials with 401, so it went to `logged_out`, `desired_state` became `stopped`, and the credentials were wiped.
- **Delete:** deleting a session worked and it then returned 404.

## What changed

**Credential storage**
- Credentials and Signal keys now live in a new `auth_creds` table, one set per session (`sqlite-auth-state.ts`).
- Deleting a session removes its credentials with it.

**Sessions**
- A `sessions` table holds the device's JID, its current `status` and your intent (`desired_state`).
- `WhatsappService` is now a manager. Each device runs as its own `SessionRuntime` (`session-runtime.ts`), which has your old socket, QR and reconnect logic.
- Every state change is written to the table by one `setState` method.
- A heartbeat refreshes `last_seen_at` for connected sessions, and `logged_out` is a new state.

**Restore on boot**
- `connect` sets `desired_state` to `connected`. `disconnect`, `logout` and being logged out from the phone set it to `stopped`.
- At boot, stale statuses are reset to `disconnected`. Then every paired session wanted as `connected` is reconnected one at a time, 1 second apart.
- Stopping the app leaves `desired_state` alone, so sessions come back on the next start.

**JWT auth**
- JWT guard is applied to every route except `register` and `login`.
- The first user to register becomes admin, and later sign-ups need `auth.allowRegistration`.
- Admins create other users with `POST /api/auth/users`, and the guard re-reads the user on each request, so deleted users lose access immediately.
- Passwords are hashed with scrypt.
- Users only reach their own sessions. Admins see all of them.

**API routes**
- Session routes moved to `/api/sessions/:id/...`, including messages. Messages are now scoped by session.
- The old `/api/whatsapp/*` and `/api/messages` routes are gone.
- `x-api-key` is removed.

## What you need to do
- **Config:** `auth.jwtSecret` is now required (at least 32 characters), and the app won't boot without it. I generated one in your local `env.json` and put a placeholder in `env.example.json`.
- **Config keys:** `authDir`, `botName` and `autoConnectOnBoot` are gone. `autoConnectOnBoot` is replaced by `restoreOnBoot`, which defaults to `true`.
- **Old session:** `auth_info_baileys/` is no longer read. Create a session, scan the QR again, then delete that folder.
- **Old messages:** they were migrated automatically but sit under a `legacy` session id, so the API doesn't show them.

I left out login rate limiting, refresh tokens and encryption of the stored credentials. Run it behind HTTPS and treat `data/bot.db` like a password store.

The README is updated with the new setup, endpoints, config table and restart behavior.

---

**User**

# Role & Objective
Act as a Principal Backend & AI Systems Engineer. Your task is to architect and implement a fully traceable, observable conversational bot system based on the provided project requirements. Every bot reply and user interaction must be 100% auditable via unique correlation IDs, capturing the exact context retrieval and decision-making pipeline so a developer can reconstruct and visualize the entire execution graph that produced a given reply.

# Project Context (Fill in or reference pasted chat)
- **Language / Runtime:** [e.g., TypeScript / Node.js (NestJS/Express) OR Python 3.11+ / FastAPI]
- **Database / Storage:** [e.g., PostgreSQL / MySQL / MongoDB / DynamoDB]
- **Search / Vector Store:** [e.g., OpenSearch / Pinecone / pgvector]
- **LLM / Agent Framework:** [e.g., OpenAI SDK / LangChain / Custom Agent Loop]
- **Core Business Logic from Chat:** [Paste the summary or transcript of the shared chat here]

# Core Architectural Requirements

## 1. End-to-End Traceability & ID Hierarchy
Every entity in the lifecycle must be linked via deterministic UUIDv4 or ULID identifiers:
- `session_id`: Groups the overarching conversation thread.
- `turn_id` (or `trace_id`): Uniquely identifies a single user-request-to-bot-reply cycle.
- `message_id`: Assigned to both the incoming user message and the outgoing bot response (`parent_message_id` linking the two).
- `span_id`: Assigned to each discrete internal step (Query Rewrite, Context Retrieval, Reranking, Tool Execution, Policy/Routing Decision, LLM Generation).

## 2. Mandatory Data Model Blueprint
Implement the persistence layer and strongly-typed models/interfaces strictly following this 4-entity blueprint:

### A. `ConversationTurn` (Top-Level Anchor)
Connects a user prompt, the resulting bot reply, and the overarching execution state.
- `turn_id` (PK, UUID/ULID): Unique identifier for this request-response cycle.
- `session_id` (Index, UUID/ULID): The conversation thread ID.
- `idempotency_key` (Unique Index, String): Prevents duplicate processing on rapid retries.
- `user_message_id` (UUID/ULID): ID of the raw incoming user message.
- `bot_message_id` (UUID/ULID, Nullable): ID of the generated bot reply (null if failed prior to generation).
- `user_input_raw` (Text): Original user message.
- `bot_reply_raw` (Text, Nullable): Final response sent to the user.
- `status` (Enum: `IN_PROGRESS`, `COMPLETED`, `FALLBACK_TRIGGERED`, `FAILED`): Final lifecycle status of the turn.
- `total_latency_ms` (Integer): End-to-end wall-clock execution time.
- `token_usage` (JSON/Object): `{ prompt_tokens, completion_tokens, total_tokens }`.
- `error_details` (JSON/Object, Nullable): `{ error_code, message, stack_trace, failed_at_span_id }`.
- `created_at` / `updated_at` (Timestamp).

### B. `RetrievalLog` (Context & Knowledge Audit)
Records what knowledge was fetched, how queries were transformed, and why specific chunks were kept or discarded.
- `retrieval_id` (PK, UUID/ULID): Unique ID for the retrieval operation.
- `turn_id` (FK -> `ConversationTurn.turn_id`, Index): Links back to the turn.
- `span_id` (FK -> `DecisionSpan.span_id`): Links to the specific execution span.
- `raw_query` (Text): Original query input.
- `rewritten_queries` (Array<String>): Expanded, translated, or reformulated search queries.
- `search_strategy` (String): e.g., `HYBRID`, `BM25`, `VECTOR_COSINE`.
- `retrieved_chunks` (Array<JSON/Sub-Document>):
  - `chunk_id` / `doc_id` (String): Source identifier.
  - `similarity_score` (Float): Raw vector/BM25 score.
  - `rerank_score` (Float, Nullable): Score after cross-encoder reranking.
  - `content_preview` (Text): Snippet or redacted text of the chunk.
  - `metadata` (JSON): Source file, tenant ID, page, or timestamp.
  - `used_in_final_prompt` (Boolean): Whether the LLM actually saw this chunk.
  - `drop_reason` (Enum, Nullable: `BELOW_THRESHOLD`, `TOKEN_BUDGET_EXCEEDED`, `DUPLICATE`, `POLICY_FILTERED`).
- `latency_ms` (Integer): Time taken for retrieval and reranking.

### C. `DecisionSpan` (Execution Graph & Reasoning Steps)
Maps the branching logic, routing, guardrails, tool selections, and LLM calls in chronological and hierarchical order.
- `span_id` (PK, UUID/ULID): Unique identifier for this discrete step.
- `turn_id` (FK -> `ConversationTurn.turn_id`, Index): Parent turn.
- `parent_span_id` (UUID/ULID, Nullable): Enables nested tree/DAG reconstruction.
- `sequence_order` (Integer): Monotonically increasing counter (`1, 2, 3...`) within the turn.
- `step_type` (Enum: `QUERY_REWRITE`, `INTENT_ROUTER`, `GUARDRAIL_CHECK`, `CONTEXT_RETRIEVAL`, `TOOL_EXECUTION`, `PROMPT_ASSEMBLY`, `LLM_GENERATION`, `FALLBACK_HANDLER`).
- `input_state` (JSON): Sanitized snapshot of inputs entering this step.
- `decision_outcome` (String/JSON): The concrete choice made (e.g., `{"selected_route": "billing_agent", "confidence": 0.94}` or `{"tool_called": "fetch_order_status"}`).
- `rationale` (Text): Explicit explanation or LLM thought-chain detailing *why* this decision was taken.
- `model_config` (JSON, Nullable): `{ model_name, temperature, prompt_template_id, prompt_version }`.
- `status` (Enum: `SUCCESS`, `RETRYING`, `FALLBACK`, `ERROR`).
- `started_at` / `ended_at` (Timestamp) & `duration_ms` (Integer).

### D. `Message` (User-Facing Chat History)
- `message_id` (PK, UUID/ULID)
- `session_id` (Index, UUID/ULID)
- `turn_id` (FK -> `ConversationTurn.turn_id`, Index)
- `parent_message_id` (UUID/ULID, Nullable): Links the bot reply directly to the user prompt `message_id`.
- `role` (Enum: `USER`, `ASSISTANT`, `SYSTEM`)
- `content` (Text)
- `created_at` (Timestamp)

## 3. Developer Inspection & Mapping API
Implement a dedicated developer debug endpoint/service (`GET /api/debug/traces/:turn_id` and `GET /api/debug/messages/:message_id/trace`):
- Reconstructs and returns a hierarchical JSON execution DAG (Directed Acyclic Graph) and ordered timeline mapping out:
  `User Input -> Query Analysis -> Context Retrieval (with kept vs. dropped chunks) -> Decision/Routing -> Tool Calls -> Prompt Assembly -> Final Bot Reply`.
- Include a helper utility (`generateMermaidTrace(turnId)`) that converts the recorded `DecisionSpan` and `RetrievalLog` records into a visual Mermaid.js flowchart string so a developer can immediately render the decision path.

## 4. Edge Cases to Explicitly Handle in Code
You MUST implement defensive handling for the following edge cases:
1. **Empty or Low-Confidence Retrieval:** When vector/context search returns 0 results or all results fall below the similarity threshold, record `drop_reason: "BELOW_THRESHOLD"` in `RetrievalLog`, log a `LOW_CONFIDENCE_CONTEXT` decision span, and trigger a deterministic fallback strategy instead of hallucinating.
2. **Partial Pipeline Failure / Mid-Turn Crash:** Wrap turn execution in a `try / catch / finally` lifecycle via the `TraceCollector`. If the LLM or a third-party tool fails or times out mid-execution, flush all completed `DecisionSpan` and `RetrievalLog` records to the database with `ConversationTurn.status = "FAILED"` and populate `error_details`.
3. **Context Window Overflow:** If retrieved context exceeds the token budget, dynamically truncate/drop the lowest-ranked chunks and explicitly set `used_in_final_prompt: false` and `drop_reason: "TOKEN_BUDGET_EXCEEDED"` on those chunk entries in `RetrievalLog`.
4. **Concurrent / Duplicate Requests (Idempotency):** Enforce `idempotency_key` checks at the start of a turn so rapid double-submissions from the client return the existing in-flight or completed `turn_id` without duplicating spans or corrupting conversation state.
5. **Malformed LLM / Tool Outputs:** Gracefully catch JSON parse errors or schema validation failures during routing/decision steps, record the raw malformed output inside a `DecisionSpan` with `status: "RETRYING"`, and execute a bounded retry or fallback.
6. **PII / Sensitive Data Redaction in Logs:** Include a sanitization hook in the `TraceCollector` so sensitive tokens, API keys, or PII fields in `input_state` and `content_preview` are masked before persisting to storage.

## 5. Code Quality & Documentation Standards
- **Comprehensive Code Comments:** Write clear, thorough JSDoc/docstrings and inline comments explaining *why* specific architectural decisions, state transitions, and edge-case guards exist.
- **Modular Structure:** Separate concerns cleanly into `models/schema`, `tracing/traceCollector`, `services/retrievalService`, `services/decisionEngine`, and `controllers/debugController`.
- **No Placeholders:** Write complete, production-ready, strongly-typed code with no `// TODO` stubs.

# Deliverables Requested
1. **Database Schema & Type Definitions** implementing `ConversationTurn`, `RetrievalLog`, `DecisionSpan`, and `Message`.
2. **`TraceCollector` Service/Context Manager** that manages span creation, parent-child ID linking, latency measurement, PII scrubbing, and guaranteed persistence in a `finally` block.
3. **Core Bot Pipeline Implementation** demonstrating a full turn from user message ingestion through retrieval, decision routing, context budget enforcement, and reply generation.
4. **Developer Trace Inspector Endpoint & Mermaid Exporter** that queries a `turn_id` or `message_id` and returns the complete execution tree.

---

**Cursor**

The brief has unfilled placeholders. I know the runtime and storage from the repo (TypeScript, NestJS, SQLite with `better-sqlite3`), but two decisions would change the plan a lot.

**Two decisions before I plan the traced bot pipeline**

> **Which LLM provider should the generation step use? I'll put it behind an `LlmClient` interface so it can be swapped, and ship a deterministic stub for tests.**
> - OpenAI SDK (Chat Completions, JSON mode for routing)
> - Anthropic SDK (Claude)
> - Google Gemini SDK ✔
> - Interface plus a stub only for now; no provider SDK yet

> **What should 'context retrieval' search over? There is no vector store in the repo today.**
> - SQLite FTS5 (BM25) over the stored group messages. No new infrastructure (Recommended)
> - FTS5 plus embeddings stored in SQLite for hybrid search (needs an embedding API) ✔
> - Pluggable retriever interface; ship FTS5 now and leave vector search for later

> **How should turns be triggered?**
> - Both: WhatsApp group mentions (existing sessions) and a REST `POST /api/chat` endpoint for testing (Recommended) ✔
> - REST `POST /api/chat` only for now
> - WhatsApp mention-triggered turns only

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

I'll implement the traced Gemini pipeline as specified. First I'll inspect the current codebase and start on dependencies and config.

Config already includes the LLM, bot, and tracing sections. I'll inspect what's already in the repo versus what still needs to be built.

A lot of the chatbot layer is already in place. I'll read those files and fill in the missing pipeline, controllers, inspector, and wiring.

The lower layers look complete. Next I’ll implement the pipeline, inspector, controllers, and WhatsApp mention wiring.

The foundation is already in place. I'll mark those todos complete and implement the pipeline, inspector, controllers, and WhatsApp wiring.

Pipeline and inspector are in place. Next I’ll add tests and a shared in-memory database helper.

Build and lint are clean. Next I’ll update the README and run a smoke test of the wired app.

The traced Gemini pipeline is in place. Every reply is a turn you can reconstruct from the database.

**Build, lint, and 49 tests pass.** A smoke boot of the real app confirmed JWT on `/api/chat` and `/api/debug/*`, `503` when `llm.apiKey` is empty, and `404` for an unknown turn.

## How a turn runs

A mention in a group (bot JID or LID) or `POST /api/chat` starts one cycle:

`GUARDRAIL → QUERY_REWRITE → INTENT_ROUTER → (optional TOOL) → CONTEXT_RETRIEVAL → PROMPT_ASSEMBLY → LLM_GENERATION`

Empty or weak retrieval skips generation and uses a fixed fallback (`LOW_CONFIDENCE_CONTEXT` + `FALLBACK_TRIGGERED`). Each step is a `DecisionSpan`. Retrieval writes kept vs dropped chunks (`BELOW_THRESHOLD`, `DUPLICATE`, `POLICY_FILTERED`, `TOKEN_BUDGET_EXCEEDED`).

## Persistence and IDs

ULIDs throughout. Four blueprint tables plus `chat_threads` (conversation thread, not the WhatsApp device):

- `conversation_turns` — unique `idempotency_key`
- `decision_spans` — parent + `sequence_order`
- `retrieval_logs` — queries, strategy, chunk fates
- `chat_messages` — user/assistant, `parent_message_id`, optional WhatsApp `external_id`

Credentials and Signal keys stay in SQLite as before. Group text is indexed with FTS5; embeddings are written in the background.

## Using it

```bash
# env.json: set llm.apiKey (Gemini). Empty key disables chat only.
curl -X POST localhost:3000/api/chat -H "authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: demo-1' -H 'content-type: application/json' \
  -d '{"deviceSessionId":"<uuid>","groupId":"1203630…@g.us","message":"when is the launch?"}'

curl localhost:3000/api/debug/traces/<turnId> -H "authorization: Bearer $TOKEN"
curl "localhost:3000/api/debug/traces/<turnId>?format=mermaid" -H "authorization: Bearer $TOKEN"
```

The debug payload is `{ turn, timeline, tree, dag, retrievals, messages, mermaid }`. Users only see their own threads.

A duplicate `Idempotency-Key` returns the same turn (HTTP `202` if it is still running). WhatsApp redeliveries use `wa:{deviceSessionId}:{messageId}`.

## Edge cases that are implemented

| Case | Behavior |
|---|---|
| Empty / low-confidence retrieval | Fallback reply, no LLM generation |
| Mid-turn crash | `finally` flushes spans and logs; turn is `FAILED` with `failed_at_span_id` |
| Context overflow | Lowest-ranked chunks get `TOKEN_BUDGET_EXCEEDED` |
| Duplicate requests | Unique key; no extra spans |
| Bad LLM JSON | `RETRYING` span, one repair, then a rule-based fallback |
| PII in traces | Redacted in span/retrieval fields; chat text stays raw |
| Process restart | In-progress turns become `FAILED` (`PROCESS_RESTART`) |

## What you need

Set `llm.apiKey` in `env.json`. I could not call Gemini from here; the pipeline tests use a stub. The reranker is heuristic (overlap, recency, quote proximity), not a cross-encoder. Swap `Reranker` later if you want one.

---

**User**

when querying the bot citations seems to be missing in the whatsapp replies 

---

**Cursor**

Citations were missing in WhatsApp replies for two reasons:

1. **Prompt wording only permitted URLs rather than requiring citations:** `ANSWER_SYSTEM` in `src/chatbot/services/prompts.ts` previously said *"Include a URL only when it appears in `<web_results>`"*, so the model usually summarized web search results without citing sources unless explicitly asked for links.
2. **No post-generation fallback when the model omitted source URLs:** When the model answered using `<web_results>` (or wrote `[1]`, `[2]` inline without listing the URLs), nothing ensured the source links were attached before sending the WhatsApp reply.

### Changes Made
- **Explicit citation rules in `ANSWER_SYSTEM` (`src/chatbot/services/prompts.ts`, prompt version `3`):**
  ```91:101:src/chatbot/services/prompts.ts
  export const ANSWER_SYSTEM = [
    'You are a helpful assistant inside a WhatsApp group. Answer the latest message using ONLY the information in <context>, <web_results> and <tool_result>.',
    'Prefer <context> for group-internal facts (who said what, plans, decisions). Use <web_results> for public or current information.',
    'If they do not contain the answer, say briefly that you could not find it. Never invent facts, names, dates or links.',
    'Always cite the sources you used:',
    '- When you use <web_results>, cite the matching result number(s) inline like [1] and end the reply with a "Sources:" section listing each cited result as "[n] Title - URL" using the exact URL from <web_results>.',
    '- When you use <context>, mention who said it (and when, if relevant).',
    '- If you could not find the answer, do not add a "Sources:" section.',
    'Keep the reply short and plain-text, suitable for WhatsApp.',
    UNTRUSTED_DATA_RULE,
  ].join('\n');
  ```
- **Deterministic citation enforcement (`appendWebCitations` in `src/chatbot/services/prompt-assembler.service.ts` & `src/chatbot/services/decision-engine.service.ts`):**
  - If the model cites `[1]`, `[2]` inline without including their URLs, those specific cited `<web_results>` URLs are appended under `Sources:`.
  - If `<web_results>` were used to answer and the model omitted URLs entirely, the top unique web sources are appended as `Sources:\n[n] Title - URL`.
  - Existing URLs in the reply are never duplicated, and "couldn't find" responses do not have sources appended.

---

**User**

Goal
When search_source is web or hybrid, keep today’s Tavily search, then extract the top result pages so Gemini sees page text, not 800-char snippets. Citations stay as they are (appendWebCitations + ANSWER_SYSTEM).

WEB_SEARCH (existing Tavily search)
  → WEB_FETCH (new: Tavily extract on top N urls)
  → PROMPT_ASSEMBLY uses extracted text, falls back to snippet
Do not
Register web_search or browse_url in ToolRegistry
Change mention / REST / idempotency / Gemini client
fetch() result URLs yourself (SSRF). Use Tavily extract only
Fail the turn if extract fails — keep snippets
Commit unless I ask
Current hooks
Search: src/chatbot/services/web-search.service.ts → POST https://api.tavily.com/search
Pipeline: ChatPipelineService.execute already Promise.alls message retrieval + searchWeb()
Hits go into PromptAssembler as <web_results> via formatWebResults
Citations: appendWebCitations in decision-engine.generate
Implementation
1. Config
Add to webSearch in env.schema.ts, DEFAULT_CONFIG, configuration.ts, env.example.json (not a real key):

extractTopN: number;        // default 3; 0 = search only
extractMaxChars: number;    // default 4000 per page
extractTimeoutMs: number;   // default 15000
Validate like the other positive ints; extractTopN may be 0.

2. WebSearchService
Keep search(). Add extract(urls: string[]):

If !enabled, extractTopN === 0, or no urls → Map<string, string> empty
Dedupe, https-only, cap to extractTopN
POST https://api.tavily.com/extract with the same API key / Bearer header
Timeout via extractTimeoutMs + AbortController
Parse Tavily extract JSON (results[].url + raw_content or content)
Truncate each body to extractMaxChars
Errors: same CodedError style as search (WEB_SEARCH_* or WEB_FETCH_*)
Export a pure parseExtract for tests
Extend WebSearchHit with optional extracted?: string.

3. Pipeline span WEB_FETCH
In chat-pipeline.service.ts, after search hits are in:

If extractTopN > 0 and there are hits, run fetchPages(collector, hits)
New private method, wrap in collector.span('WEB_FETCH', { urls, provider: 'tavily' }, …)
Merge extract text onto hits by URL
Span outcome: url, chars, latency, how many succeeded
catch → return original hits (ERROR span already recorded)
Add WEB_FETCH everywhere the step enum lives:

src/chatbot/models/types.ts STEP_TYPES
src/chatbot/models/trace.schema.ts CHECK
src/chatbot/inspector/trace-inspector.service.ts STAGE_OF → 'Context Retrieval'
mermaid/inspector tests if they enumerate step types
Existing DBs: CREATE TABLE IF NOT EXISTS will not update the CHECK. Add a small migration in DatabaseService (same style as other migrations) to recreate/replace the spans CHECK so WEB_FETCH can persist. If you skip that, say so in the PR/summary — inserts will fail on old files.

4. Prompt
In formatWebResults, use neutralize(h.extracted || h.content).
Web tokens stay reserved first so hybrid group chunks cannot wipe extracts.
If extracts are huge, they still count against contextTokenBudget — do not raise the default budget unless tests force it.

appendWebCitations should keep working (same urls). No prompt rewrite required; optional one-liner that <web_results> may include extracted page text.

5. Tests (no live Tavily)
web-search.service.spec.ts: parse extract JSON; skip non-https; empty when extractTopN is 0; timeout → coded error
chat-pipeline.service.spec.ts: mock search + extract; assembled prompt contains extracted text; extract throw still COMPLETED from snippets; WEB_FETCH span present
prompt-assembler.service.spec.ts: prefers extracted over content
Inspector/schema tests if they list step types
Reuse the existing globalThis.fetch mock pattern in the pipeline spec.

6. Style
Match the repo: ESM .js imports, Nest injectables, no extra comments, no new deps, pnpm test + lint on touched files must pass.

Done when
A web/hybrid turn trace is WEB_SEARCH then WEB_FETCH then PROMPT_ASSEMBLY, <web_results> has page text when extract succeeds, citations still list the same URLs, and extract failure degrades to snippets without failing the turn.

---

**Cursor**

Implemented `WEB_FETCH` via Tavily Extract after `WEB_SEARCH` for `web` and `hybrid` turns:

1. **Configuration (`src/config/env.schema.ts`, `src/config/configuration.ts`, `env.example.json`):**
   - Added `extractTopN` (default `3`, `0` disables extraction), `extractMaxChars` (default `4000`), and `extractTimeoutMs` (default `15000`) under `webSearch`.
2. **Tavily Extract (`src/chatbot/services/web-search.service.ts`):**
   - Extended `WebSearchHit` with `extracted?: string`.
   - Added `extract(urls)` and exported pure `parseExtract(payload, maxChars)`.
   - Dedupes URLs, keeps `https://` only, caps to `extractTopN`, calls `POST https://api.tavily.com/extract` with `AbortController` timeout (`extractTimeoutMs`), truncates each page body to `extractMaxChars`, and throws `CodedError` (`WEB_FETCH_REJECTED`, `WEB_FETCH_TIMEOUT`, `WEB_FETCH_UNAVAILABLE`) on failure.
3. **`WEB_FETCH` Span & Schema Migration (`src/chatbot/pipeline/chat-pipeline.service.ts`, `src/chatbot/models/types.ts`, `src/chatbot/models/trace.schema.ts`, `src/database/database.service.ts`, `src/chatbot/inspector/`):**
   - Added `fetchPages(collector, hits)` wrapped in a `WEB_FETCH` span after `WEB_SEARCH` and before `PROMPT_ASSEMBLY`, recording per-URL char counts, latency, and success count, and falling back to search snippets if extraction errors.
   - Added `WEB_FETCH` to `STEP_TYPES`, SQLite `decision_spans` `CHECK` constraint, `DatabaseService.migrateDecisionSpans()` (so existing SQLite DBs upgrade automatically on boot), `TraceInspectorService` (`Context Retrieval`), and Mermaid/DAG data edges.
4. **Prompt Assembly (`src/chatbot/services/prompt-assembler.service.ts`):**
   - `formatWebResults` now uses `neutralize(h.extracted || h.content)` while keeping `appendWebCitations` unchanged.

---

**User**

bot doesnt seem the ability you mentions particular member or all. if a members asks to tag/mention using names or mentions bot should be able to mention the members or all

---

**Cursor**

The bot can now mention specific group members (by name or `@mention`) as well as `@all` / `@everyone` on WhatsApp.

### What Was Fixed

1. **Baileys WhatsApp `mentions` Payload (`src/whatsapp/dto/send-message.dto.ts`, `src/whatsapp/session-runtime.ts`, `src/whatsapp/whatsapp.service.ts`)**
   - Added `mentions?: string[]` to `SendMessageDto` and passed `{ text, mentions }` to `sock.sendMessage(...)` so Baileys populates `extendedTextMessage.contextInfo.mentionedJid` for clickable WhatsApp mentions.
   - Added `SessionRuntime.getGroupMembers(groupId)` and `WhatsappService.getGroupMembers(sessionId, groupId)`, combining stored group senders from SQLite (`MessagesRepository.listGroupMembers`) with live `sock.groupMetadata(groupId)` participants (while excluding the bot's own JID/LID).

2. **Group Member Directory & Mention Resolution (`src/chatbot/services/mentions.ts`, `src/messages/messages.repository.ts`)**
   - Added `formatMembersBlock(members)` (`<members>\n- Name: @<id>\n</members>`) and `annotateMentions(text, members)` so the LLM sees every participant's name alongside their `@<id>` handle and knows who was tagged in earlier messages.
   - Added `resolveMentions(reply, question, members, inboundMentionedJids)`:
     - Expands `@all` / `@everyone` / `"tag all"` / `"mention everyone"` into every group member's `@<id>` and JID.
     - Converts `@Name` or plain names (case- and diacritic-insensitive, e.g. `"vinay"` $\rightarrow$ `"Vinay Jampana"`, `"khushi"` $\rightarrow$ `"Khü Shï"`) into `@<id>` when a user asks to tag/mention/ping someone.
     - Collects all matching `@<id>` handles in the final reply into `mentionedJids`.
   - Added `expandMemberQueries(...)` so message retrieval searches by both a member's name and their `@<id>` handle when looking up messages where someone was tagged.

3. **Prompt & Pipeline Wiring (`src/chatbot/services/prompts.ts`, `src/chatbot/services/prompt-assembler.service.ts`, `src/chatbot/pipeline/chat-pipeline.service.ts`, `src/chatbot/pipeline/chat.service.ts`)**
   - Updated `ANSWER_SYSTEM` (v4) and `SMALLTALK_SYSTEM` (v2) so the model knows it can tag members using their `@<id>` handles from `<members>`.
   - Wired `resolveMentions` into `ChatPipelineService.execute` and passed `mentions: result.mentionedJids` in `ChatService.handleMention`.

---

**User**

In `src/whatsapp/session-runtime.ts`, implement full historical WhatsApp group message ingestion without triggering replies on old mentions:

1. In `doStartSocket()`, set `syncFullHistory: true` in `makeWASocket({...})`.
2. Add a `sock.ev.on('messaging-history.set', ({ messages }) => ...)` listener that checks `if (!isCurrent()) return;` and ingests each message with `allowMentionReply = false`.
3. Update the `sock.ev.on('messages.upsert', ({ messages, type }) => ...)` listener to pass `type === 'notify'` as `allowMentionReply` to `this.ingest(m, type === 'notify')`.
4. Update `private ingest(msg: WAMessage, allowMentionReply = false): void` so `this.deps.onMention?.(this.id, stored)` only fires when `allowMentionReply && !stored.isBot && this.mentionsBot(stored)`.
5. Add or update unit tests to verify that historical/append messages are stored in `messages` without triggering `onMention`, while live `notify` messages with a bot mention still trigger `onMention`. Run `pnpm test` and `pnpm lint`.

---

**Cursor**

Implemented full historical WhatsApp group message ingestion in `src/whatsapp/session-runtime.ts`:

1. **Enabled Full History Sync:** Set `syncFullHistory: true` in `makeWASocket({...})` inside `doStartSocket()`.
2. **Historical Batch Ingestion (`messaging-history.set`):** Added a `sock.ev.on('messaging-history.set', ({ messages }) => ...)` listener that guards on `if (!isCurrent()) return;` and ingests each message with `allowMentionReply = false`.
3. **Upsert Mention Gating (`messages.upsert`):** Updated `sock.ev.on('messages.upsert', ({ messages, type }) => ...)` to pass `type === 'notify'` as `allowMentionReply` to `this.ingest(m, allowMentionReply)`.
4. **Conditional `onMention` Dispatch (`ingest`):** Updated `private ingest(msg: WAMessage, allowMentionReply = false): void` so `this.deps.onMention?.(this.id, stored)` only runs when `allowMentionReply && !stored.isBot && this.mentionsBot(stored)`.
5. **Unit Tests (`src/whatsapp/session-runtime.spec.ts`):** Added unit tests verifying `syncFullHistory: true`, confirming that `messaging-history.set` and `messages.upsert` (`type: 'append'`) store messages without firing `onMention`, and confirming that `messages.upsert` (`type: 'notify'`) triggers `onMention` when the bot is mentioned.

---

**User**

Implement the WhatsApp Chat Export (`.txt`) & JSON Import API and active-only `@mention` member filtering:

1. **WhatsApp Chat Export (`.txt`) & JSON Import API (`POST /api/sessions/:sessionId/messages/import`):**
   - Add an import endpoint on `MessagesController` (`src/messages/messages.controller.ts`) with DTO validation (`src/messages/dto/import-messages.dto.ts`) accepting:
     - `groupId` (`...@g.us`)
     - `exportText` (optional raw string from WhatsApp's "Export chat -> Without media" `.txt` file)
     - `messages` (optional array of structured messages `{ id?, senderId?, senderName?, text, timestamp }`)
   - Build a parser (`src/messages/chat-export.parser.ts`) that:
     - Parses standard WhatsApp `.txt` export formats (Android `DD/MM/YYYY, HH:MM - Sender: text` and iOS/Desktop `[DD/MM/YYYY, HH:MM:SS] Sender: text`, supporting 2-digit/4-digit years, 12h AM/PM and 24h clocks, and multi-line messages).
     - Preserves messages from deleted/former group members (e.g. raw phone numbers like `+91 98765 43210`, display names of people who left, or `"WhatsApp User"`), mapping phone numbers to `<digits>@s.whatsapp.net` and display-name-only senders to a deterministic JID (`export_<slug>@s.whatsapp.net`) while keeping `senderName`.
     - Skips WhatsApp system/notice lines (lines without `Sender: text`, e.g. encryption notices, "left", "added", and `<Media omitted>` / `image omitted`).
     - Generates deterministic message IDs (`import_<sha1>`) so re-importing the same `.txt` file is idempotent.
     - Inserts each message via `MessagesRepository.insert(sessionId, msg)` so SQLite `messages`, FTS5 (`messages_fts`), and vector embeddings (`message_embeddings`) are populated automatically.
   - Return `{ groupId, totalParsed, inserted, duplicatesSkipped }`.

2. **Active-only `@mention` members (`src/whatsapp/session-runtime.ts`):**
   - In `SessionRuntime.getGroupMembers(groupId)`, when `sock.groupMetadata(groupId)` succeeds, only return current participants from `meta.participants` (using stored messages in `known` only to fill in missing `name` fields for those active participants). Fall back to `known` only if `groupMetadata()` fails or the socket is disconnected. This ensures former/deleted members' messages remain searchable in `<context>` without the bot trying to `@mention` people who already left.

3. **Unit tests:**
   - Add unit tests for `chat-export.parser.ts` (Android & iOS formats, 12h/24h timestamps, multi-line messages, deleted/former members, system/media-omitted filtering, idempotent IDs) and for active-only `getGroupMembers` filtering in `session-runtime.spec.ts`.

---

**Cursor**

Implemented the WhatsApp Chat Export (`.txt`) & JSON Import API and active-only `@mention` member filtering:

1. **WhatsApp `.txt` & JSON Import Endpoint (`POST /api/sessions/:sessionId/messages/import`)**
   - **`src/messages/dto/import-messages.dto.ts`**: Added `ImportMessagesDto` and `ImportMessageItemDto` validating `groupId` (`...@g.us`), `exportText`, and/or `messages`.
   - **`src/messages/chat-export.parser.ts`**:
     - `parseWhatsAppExportText(groupId, exportText)` parses both Android (`DD/MM/YYYY, HH:MM - Sender: text`) and iOS/Desktop (`[DD/MM/YY, HH:MM:SS] Sender: text`) exports with 12h/24h clocks, 2-digit/4-digit years, directional Unicode marks, and multi-line messages.
     - `resolveExportSender(rawSender, explicitSenderId)` preserves former/deleted group members by mapping phone-number senders (`+91 98765 43210`) to `<digits>@s.whatsapp.net` and display-name-only senders (including `"WhatsApp User"`) to deterministic `export_<slug>_<hash>@s.whatsapp.net` JIDs while retaining `senderName`.
     - Skips WhatsApp system lines and `<Media omitted>` / `image omitted` placeholders, and generates deterministic `import_<sha1>` IDs so re-imports are idempotent.
   - **`src/messages/messages.controller.ts`**: Added `@Post('import')` on `MessagesController`, inserting parsed messages through `MessagesRepository.insert(sessionId, msg)` (populating SQLite `messages`, `messages_fts`, and the embedding listener) and returning `{ groupId, totalParsed, inserted, duplicatesSkipped }`.

2. **Active-Only `@mention` Members (`src/whatsapp/session-runtime.ts`)**
   - Updated `SessionRuntime.getGroupMembers(groupId)` so that when `sock.groupMetadata(groupId)` succeeds, only current `meta.participants` are returned (enriching missing `name` fields from `known` stored messages), falling back to `known` only when `groupMetadata()` fails or the socket is disconnected.

3. **Unit Tests (`src/messages/chat-export.parser.spec.ts`, `src/whatsapp/session-runtime.spec.ts`)**
   - Added unit tests covering Android/iOS `.txt` parsing, multi-line messages, former/deleted member resolution, media/system notice filtering, idempotent IDs, and active-only `getGroupMembers` filtering. All 15 test suites (99 tests), `pnpm build`, and `pnpm lint` pass.

---

**User**

Implement Task 5 — a lightweight evaluation harness to prove the bot does not hallucinate:

1. **Evaluation Dataset (`src/chatbot/eval/eval-dataset.ts`):**
   - Seed a realistic fixture of WhatsApp group messages (covering project decisions, deployment schedules, venues/restaurants, member tasks, former/deleted member notes, and a message containing a secret API key to test redaction/policy filtering).
   - Define 20–25 evaluation test cases across 5 categories:
     1. `group_context` (6–7 prompts): questions answerable strictly from seeded group messages (including multi-message synthesis and messages from former/deleted members).
     2. `web_browsing` (5 prompts): questions requiring live/public web search via Tavily (`search_source: 'web'`), checking that `[n]` citations and `Sources:` URLs are present.
     3. `hybrid` (3–4 prompts): questions combining a group chat entity with live web info (`search_source: 'hybrid'`, e.g. "Is the restaurant Priya suggested open right now?").
     4. `unanswerable_abstention` (4 prompts): questions about group topics that were never discussed (or whose only matching message was `POLICY_FILTERED` due to a secret), verifying the bot triggers `LOW_CONFIDENCE_CONTEXT` + `FALLBACK_TRIGGERED` instead of hallucinating.
     5. `refusal_or_clarify` (4 prompts): ambiguous questions (`route: 'clarify'`), out-of-scope requests (`route: 'out_of_scope'`), and guardrail rejections (`GUARDRAIL_CHECK` for empty/oversized input).

2. **Evaluation Runner & Scorer (`src/chatbot/eval/eval-runner.ts`):**
   - Run every test case through the real `ChatPipelineService` (with in-memory SQLite, FTS5, embeddings, `DecisionEngine`, `RetrievalService`, `PromptAssembler`, and `TraceCollector`).
   - Support deterministic offline mode (using scripted/heuristic LLM + mocked Tavily fixtures so CI/tests run without external API keys) as well as optional `--live` mode when `env.json` has `llm.apiKey` / `webSearch.apiKey`.
   - For each prompt, evaluate and score:
     - `routeMatch`: expected route (`answer_from_context`, `clarify`, `out_of_scope`, `smalltalk`)
     - `sourceMatch`: expected `search_source` (`messages`, `web`, `hybrid`, `none`)
     - `statusMatch`: expected turn status (`COMPLETED` vs `FALLBACK_TRIGGERED`)
     - `groundednessPass`: reply contains required ground-truth substrings/citations (`mustInclude`) and contains none of the forbidden/hallucinated terms (`mustNotInclude`).
   - Produce a structured summary report (total cases, pass rate, breakdown by category, per-case pass/fail table, and average latency).

3. **CLI Script & Automated Jest Spec (`src/chatbot/eval/run-eval.ts` & `src/chatbot/eval/eval.spec.ts`):**
   - Add a CLI entry point (`src/chatbot/eval/run-eval.ts`) and a `"eval"` script in `package.json` (`pnpm eval`) that prints the formatted evaluation scorecard table to the terminal and exits non-zero if any case fails.
   - Add `src/chatbot/eval/eval.spec.ts` so `pnpm test` runs the entire 20–25 prompt evaluation dataset and asserts 100% pass rate.
   - Document how to run the evaluation harness (`pnpm eval`) in `README.md`.

---

**Cursor**

Implemented the anti-hallucination evaluation harness across `src/chatbot/eval/`:

1. **Evaluation Dataset (`src/chatbot/eval/eval-dataset.ts`)**
   - Seeded `EVAL_SEED_MESSAGES` with 11 realistic WhatsApp group messages covering release schedules, PostgreSQL 16 + `pgvector` architecture decisions, dinner venue proposals and reservations, sprint action items, notes from former/deleted group members (`Rahul (Former Member)` and `+91 98765 43210`), multi-message Q3 budget updates, and an `sk-live-*` secret to test `POLICY_FILTERED` redaction.
   - Defined **23 evaluation test cases** (`EVAL_CASES`) across all 5 categories:
     - `group_context` (7 cases): single-message and multi-message synthesis over group history, including messages from former/deleted members.
     - `web_browsing` (5 cases): public/live web queries via Tavily (`search_source: 'web'`), verifying inline `[1]` markers, `Sources:` URLs, and abstention when Tavily returns zero hits.
     - `hybrid` (3 cases): combining group chat entities (Priya's dinner venue, Shubham's AWS region, Rahul's S3 Glacier bucket) with public web facts (`search_source: 'hybrid'`).
     - `unanswerable_abstention` (4 cases): questions on topics never discussed in chat or dropped by `POLICY_FILTERED`, verifying `LOW_CONFIDENCE_CONTEXT` + `FALLBACK_TRIGGERED` instead of hallucination.
     - `refusal_or_clarify` (4 cases): ambiguous requests (`route: 'clarify'`), harmful/out-of-scope requests (`route: 'out_of_scope'`), and guardrail rejections (`GUARDRAIL_CHECK`).

2. **Evaluation Runner & Scorer (`src/chatbot/eval/eval-runner.ts`)**
   - Runs every test case through the real `ChatPipelineService`, `DecisionEngine`, `RetrievalService` (SQLite FTS5 + vector embeddings), `PromptAssembler`, and `TraceCollector`.
   - Scores `routeMatch`, `sourceMatch`, `statusMatch`, and `groundednessPass` (`mustInclude` / `mustNotInclude`), and formats a full summary report via `formatEvalReport()`.
   - Supports deterministic offline mode (`pnpm eval`) as well as `--live` mode (`pnpm eval -- --live`).

3. **CLI Entry Point, Jest Spec & Docs (`src/chatbot/eval/run-eval.ts`, `src/chatbot/eval/eval.spec.ts`, `package.json`, `README.md`)**
   - Added `"eval": "nest build && node dist/chatbot/eval/run-eval.js"` to `package.json` and documented usage in `README.md`.
   - Added `src/chatbot/eval/eval.spec.ts` asserting 100% pass rate across all 23 cases in `pnpm test`.

