-- migrations/040_agent_tls_certificates.sql
-- Per-host self-signed TLS certificate the manager pins as trust anchor for
-- manager-to-agent HTTPS. cert_pem is public and stored plaintext; the agent
-- needs it as its serving certificate. private_key_jwe: JWE compact
-- serialization of the openssl private key PEM, encrypted under the master
-- keyring like agent_keypairs.private_jwk_jwe so the wizard can redisplay the
-- key file the operator copies to the host.
CREATE TABLE IF NOT EXISTS agent_tls_certificates (
  host_name TEXT PRIMARY KEY
    REFERENCES managed_hosts(name)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  cert_pem TEXT NOT NULL,
  private_key_jwe TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rollback:
-- DROP TABLE IF EXISTS agent_tls_certificates;
