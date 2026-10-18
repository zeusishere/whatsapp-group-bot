/**
 * DDL for the traceability layer.
 *
 * Design notes:
 *  - All timestamps are epoch milliseconds, like the rest of the database.
 *  - JSON columns are TEXT; (de)serialization lives in `TraceRepository`.
 *  - Enum columns carry CHECK constraints so a bug in application code can never persist a value
 *    the debug tooling does not know how to render.
 *  - `decision_spans.parent_span_id` is deliberately NOT a foreign key: a span is persisted when it
 *    closes, and children close before their parent, so the parent row does not exist yet when the
 *    child is written. The tree is reconstructed in memory by `TraceInspectorService`.
 *  - `conversation_turns.user_message_id` / `bot_message_id` are not foreign keys either: they
 *    would form a cycle with `chat_messages.turn_id`.
 */
export const TRACE_SCHEMA_SQL = `
-- A conversation thread ("session_id" in the trace blueprint). Not to be confused with the
-- WhatsApp device row in \`sessions\`. It binds a thread to the device + group whose stored
-- messages are searched, and carries the owner used for debug-endpoint authorization.
CREATE TABLE IF NOT EXISTS chat_threads (
  session_id        TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  chat_jid          TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (device_session_id, chat_jid)
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_owner ON chat_threads (owner_id);

-- A: top-level anchor of one request -> reply cycle.
CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_id          TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES chat_threads(session_id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  user_message_id  TEXT NOT NULL,
  bot_message_id   TEXT,
  user_input_raw   TEXT NOT NULL,
  bot_reply_raw    TEXT,
  status           TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FALLBACK_TRIGGERED','FAILED')),
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  token_usage      TEXT NOT NULL DEFAULT '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}',
  error_details    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The unique index is the idempotency guard: a second claim of the same key fails atomically.
CREATE UNIQUE INDEX IF NOT EXISTS ux_turns_idempotency ON conversation_turns (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_turns_session ON conversation_turns (session_id, created_at);

-- C: one row per discrete pipeline step.
CREATE TABLE IF NOT EXISTS decision_spans (
  span_id          TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
  parent_span_id   TEXT,
  sequence_order   INTEGER NOT NULL,
  step_type        TEXT NOT NULL CHECK (step_type IN (
    'QUERY_REWRITE','INTENT_ROUTER','GUARDRAIL_CHECK','CONTEXT_RETRIEVAL','WEB_SEARCH','TOOL_EXECUTION',
    'PROMPT_ASSEMBLY','LLM_GENERATION','FALLBACK_HANDLER','LOW_CONFIDENCE_CONTEXT')),
  input_state      TEXT NOT NULL DEFAULT '{}',
  decision_outcome TEXT,
  rationale        TEXT,
  model_config     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('SUCCESS','RETRYING','FALLBACK','ERROR')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  UNIQUE (turn_id, sequence_order)
);

CREATE INDEX IF NOT EXISTS idx_spans_parent ON decision_spans (parent_span_id);

-- B: what was retrieved, how queries were rewritten, and why chunks were kept or dropped.
CREATE TABLE IF NOT EXISTS retrieval_logs (
  retrieval_id      TEXT PRIMARY KEY,
  turn_id           TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
  span_id           TEXT NOT NULL REFERENCES decision_spans(span_id) ON DELETE CASCADE,
  raw_query         TEXT NOT NULL,
  rewritten_queries TEXT NOT NULL DEFAULT '[]',
  search_strategy   TEXT NOT NULL,
  retrieved_chunks  TEXT NOT NULL DEFAULT '[]',
  latency_ms        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_retrieval_turn ON retrieval_logs (turn_id);

-- D: user-facing chat history. (Named chat_messages: \`messages\` already stores ingested group chatter.)
CREATE TABLE IF NOT EXISTS chat_messages (
  message_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES chat_threads(session_id) ON DELETE CASCADE,
  turn_id           TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
  parent_message_id TEXT,
  role              TEXT NOT NULL CHECK (role IN ('USER','ASSISTANT','SYSTEM')),
  content           TEXT NOT NULL,
  external_id       TEXT,         -- WhatsApp message id when the message travelled over WhatsApp
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn ON chat_messages (turn_id);

-- Retrieval support ---------------------------------------------------------------------------

-- Full-text index over ingested group messages. Linked to \`messages\` by rowid so trigger deletes
-- (retention trims) are O(log n). \`ensureRetrievalIndexes\` rebuilds it if the counts ever drift
-- (e.g. after a VACUUM renumbered rowids).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  session_id UNINDEXED,
  group_id   UNINDEXED,
  message_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text, session_id, group_id, message_id)
  VALUES (new.rowid, new.text, new.session_id, new.group_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

-- Embedding vectors (little-endian float32). One per ingested message, produced asynchronously.
CREATE TABLE IF NOT EXISTS message_embeddings (
  session_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, group_id, message_id)
);

-- Keep embeddings in step with the retention trim and session deletion.
CREATE TRIGGER IF NOT EXISTS trg_messages_embeddings_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_embeddings
  WHERE session_id = old.session_id AND group_id = old.group_id AND message_id = old.id;
END;
`;

/**
 * Rebuilds `decision_spans` so existing databases pick up a new `step_type` CHECK value.
 * SQLite cannot ALTER a CHECK constraint in place. Foreign keys are off for the swap.
 */
export const MIGRATE_DECISION_SPANS_WEB_SEARCH_SQL = `
CREATE TABLE decision_spans_new (
  span_id          TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
  parent_span_id   TEXT,
  sequence_order   INTEGER NOT NULL,
  step_type        TEXT NOT NULL CHECK (step_type IN (
    'QUERY_REWRITE','INTENT_ROUTER','GUARDRAIL_CHECK','CONTEXT_RETRIEVAL','WEB_SEARCH','TOOL_EXECUTION',
    'PROMPT_ASSEMBLY','LLM_GENERATION','FALLBACK_HANDLER','LOW_CONFIDENCE_CONTEXT')),
  input_state      TEXT NOT NULL DEFAULT '{}',
  decision_outcome TEXT,
  rationale        TEXT,
  model_config     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('SUCCESS','RETRYING','FALLBACK','ERROR')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  UNIQUE (turn_id, sequence_order)
);
INSERT INTO decision_spans_new SELECT * FROM decision_spans;
DROP TABLE decision_spans;
ALTER TABLE decision_spans_new RENAME TO decision_spans;
CREATE INDEX IF NOT EXISTS idx_spans_parent ON decision_spans (parent_span_id);
`;
