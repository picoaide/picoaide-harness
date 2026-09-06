-- 0020: usage rows carry a kind (chat | embedding) so pending-stream cleanup
-- only targets chat rows. Embedding rows legitimately record prompt_tokens>0
-- with completion_tokens=0, and rows whose upstream omitted usage are real
-- request counts — they must not be purged as stale stream pendings.
ALTER TABLE usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
