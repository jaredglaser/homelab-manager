-- Proxmox connections are saved from Settings, with the token secret encrypted under the master keyring.
-- The worker runs one collector per row and records its state under the row's id.

CREATE TABLE IF NOT EXISTS proxmox_connections (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL CHECK (name <> ''),
  address           TEXT NOT NULL CHECK (address <> ''),
  port              INTEGER NOT NULL DEFAULT 8006 CHECK (port BETWEEN 1 AND 65535),
  token_id          TEXT NOT NULL CHECK (token_id <> ''),
  token_secret_jwe  TEXT NOT NULL,
  allow_self_signed BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stats rows carry the address as their host, so two connections to one address would write the same entities.
CREATE UNIQUE INDEX IF NOT EXISTS proxmox_connections_address_key ON proxmox_connections (lower(address));

-- Rows recorded under the address by the environment-variable collector belong to no saved connection.
DELETE FROM proxmox_collector_state;

ALTER TABLE proxmox_collector_state DROP CONSTRAINT IF EXISTS proxmox_collector_state_valid_state;
ALTER TABLE proxmox_collector_state ADD CONSTRAINT proxmox_collector_state_valid_state CHECK (
  state IN ('collecting', 'unreachable', 'token_rejected', 'certificate_refused')
);
