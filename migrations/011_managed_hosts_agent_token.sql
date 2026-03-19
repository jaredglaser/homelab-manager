-- Add plaintext agent token column for worker authentication to agent SSE endpoints.
-- The worker needs the token to send Authorization: Bearer <token> headers.
-- Security note: the socket_proxy_url column already provides equivalent access,
-- so storing the plaintext token does not meaningfully increase attack surface.
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_token TEXT;
