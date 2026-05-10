-- Stack environment-variable secrets, JWE-encrypted at rest.
-- Replaces OpenBao path secret/data/stacks/<stack>/<var>.
CREATE TABLE IF NOT EXISTS stack_secrets (
  stack_name TEXT NOT NULL,
  variable_name TEXT NOT NULL,
  ciphertext_jwe TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stack_name, variable_name)
);
