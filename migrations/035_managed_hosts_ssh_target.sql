-- migrations/035_managed_hosts_ssh_target.sql
-- Per-host SSH target for Ansible runs. The agent URL is an HTTP endpoint that may be a
-- reverse proxy, a container name, or a loopback address that means the app's own box, so
-- it cannot stand in for the address sshd answers on. NULL keeps the previous derivation
-- (agent URL hostname, then host name), so existing rows are unaffected.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS ssh_host TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS ssh_user TEXT;
