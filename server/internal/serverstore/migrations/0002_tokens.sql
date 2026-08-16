CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
