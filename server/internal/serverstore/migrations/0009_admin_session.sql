CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_key TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);
