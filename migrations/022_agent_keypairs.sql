-- Per-agent Ed25519 keypair for JWT-based auth.
-- Replaces OpenBao path secret/data/hosts/<hostname>/agent_token.
-- private_jwk_jwe: JWE compact serialization of the private JWK (JSON).
-- public_jwk: public JWK as JSONB; non-secret, queryable, kept as canonical JSON.
CREATE TABLE IF NOT EXISTS agent_keypairs (
  host_name TEXT PRIMARY KEY
    REFERENCES managed_hosts(name)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  private_jwk_jwe TEXT NOT NULL,
  public_jwk JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);
