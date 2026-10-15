export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
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
  PRIMARY KEY (group_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages (group_id, timestamp);
`;
