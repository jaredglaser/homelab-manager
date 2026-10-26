-- migrations/041_agent_tls_certificates.sql
-- Public certificate the manager pins as trust anchor for manager-to-agent
-- HTTPS. The agent generates and keeps its own private key at /tls/enroll, so
-- the manager stores no key material; cert_pem is public and plaintext.
CREATE TABLE IF NOT EXISTS agent_tls_certificates (
  host_name TEXT PRIMARY KEY
    REFERENCES managed_hosts(name)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  cert_pem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
