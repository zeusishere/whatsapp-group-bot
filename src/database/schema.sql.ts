export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  created_at    INTEGER NOT NULL
);

-- One row per linked WhatsApp device.
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                TEXT,
  jid                  TEXT,
  lid                  TEXT,
  status               TEXT NOT NULL DEFAULT 'disconnected', -- observed state
  desired_state        TEXT NOT NULL DEFAULT 'stopped',      -- intent: 'connected' | 'stopped'
  last_disconnect_code INTEGER,
  last_connected_at    INTEGER,
  last_seen_at         INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (owner_id);

-- Baileys credentials and Signal keys, one row per (session, type, id). Treat like a password.
CREATE TABLE IF NOT EXISTS auth_creds (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,     -- 'creds' or a Signal key category ('pre-key', 'session', ...)
  id         TEXT NOT NULL,
  value      TEXT NOT NULL,     -- JSON serialized with Baileys' BufferJSON
  PRIMARY KEY (session_id, type, id)
);

CREATE TABLE IF NOT EXISTS messages (
  session_id          TEXT NOT NULL,
  id                  TEXT NOT NULL,
  group_id            TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  sender_name         TEXT,
  text                TEXT NOT NULL,
  timestamp           INTEGER NOT NULL,          -- unix epoch milliseconds
  is_bot              INTEGER NOT NULL DEFAULT 0,
  quoted_message_id   TEXT,
  quoted_participant  TEXT,
  mentioned_jids      TEXT NOT NULL DEFAULT '[]', -- JSON array of JIDs
  PRIMARY KEY (session_id, group_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_group_ts ON messages (session_id, group_id, timestamp);
`;

/** Session id given to messages stored before multi-session support existed. */
export const LEGACY_SESSION_ID = 'legacy';

/** Rebuilds a pre-multi-session `messages` table (no `session_id`), keeping its rows. */
export const MIGRATE_MESSAGES_SQL = `
DROP INDEX IF EXISTS idx_messages_group_ts;
ALTER TABLE messages RENAME TO messages_old;
CREATE TABLE messages (
  session_id          TEXT NOT NULL,
  id                  TEXT NOT NULL,
  group_id            TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  sender_name         TEXT,
  text                TEXT NOT NULL,
  timestamp           INTEGER NOT NULL,
  is_bot              INTEGER NOT NULL DEFAULT 0,
  quoted_message_id   TEXT,
  quoted_participant  TEXT,
  mentioned_jids      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, group_id, id)
);
INSERT INTO messages
  SELECT '${LEGACY_SESSION_ID}', id, group_id, sender_id, sender_name, text, timestamp, is_bot,
         quoted_message_id, quoted_participant, mentioned_jids
  FROM messages_old;
DROP TABLE messages_old;
`;
