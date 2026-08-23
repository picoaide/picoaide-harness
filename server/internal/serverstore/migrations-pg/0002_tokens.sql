CREATE TABLE api_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
