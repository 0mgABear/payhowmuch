CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('group', 'owner')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  interval TEXT NOT NULL CHECK(interval IN ('monthly', 'yearly')),
  day INTEGER NOT NULL,
  next_remind_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_chat_id ON reminders(chat_id);
