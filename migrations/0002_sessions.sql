CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, user_id)
);
