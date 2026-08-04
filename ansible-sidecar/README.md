# Ansible sidecar

Execution sidecar for the Ansible layer proposed in issue #416. Runs `ansible-runner` as a
library and exposes a small HTTP surface the app dispatches runs against.

Off by default. The app only talks to this service when `ANSIBLE_RUNNER_ENABLED=true`; the
agent deploy path is unaffected either way.

## Why a separate container

- Keeps Python, `ansible-core`, and the collections out of the Bun image.
- Keeps SSH private keys out of the web-facing process.
- `ansible-core` is GPL-3.0-or-later and this repository is Apache-2.0. A separate service
  invoked over HTTP is aggregation, not a combined work.

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness for the Docker healthcheck |
| POST | `/runs` | bearer | Start a run: `{ runId, playbook, hosts, check, extravars }` |
| GET | `/runs/{id}/events` | bearer | SSE stream of runner job events, terminated by `event: end` |
| POST | `/runs/{id}/cancel` | bearer | Set the run's `cancel_callback` flag |

`POST /runs` answers 409 when any requested host is already claimed by an in-flight run. The
lock is in-process: there is one sidecar. A second one would need a PostgreSQL advisory lock,
the same mechanism the deploy pipeline uses for stack concurrency.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANSIBLE_SIDECAR_PORT` | `9095` | Listen port |
| `ANSIBLE_SIDECAR_TOKEN` | (required) | Shared secret with the app |
| `ANSIBLE_PRIVATE_DATA_DIR` | `/runner` | ansible-runner private data directory |
| `ANSIBLE_HOST_KEY_CHECKING` | `True` | Passed through explicitly; runner defaults it to `False` when absent |
| `ANSIBLE_JOB_TIMEOUT_SECONDS` | `1800` | Wall-clock cap per run |
| `ANSIBLE_IDLE_TIMEOUT_SECONDS` | `600` | No-output cap per run |
| `HLM_API_URL` | (required) | Base URL the inventory script calls back on |
| `HLM_API_TOKEN` | (required) | Bearer token for `/api/ansible-inventory` |

## Secrets

Extravars are passed with `suppress_env_files=True`, so nothing decrypted is written to
`/runner/env/`. Tasks that consume a secret are marked `no_log`, which keeps the value out of
stdout, out of `event_data.res`, and therefore out of the job-event artifacts and the SSE
stream. Extravars do reach the `ansible-playbook` argument vector, which is visible to any
process that can read `/proc` inside this container; that is the residual exposure and the
reason nothing else runs here.

## Playbooks

`project/host_baseline.yml` is the only playbook. It installs baseline packages, reports
whether a Docker engine is present, ensures a service user and group, creates the appdata
root with configurable ownership and mode, and writes one credential file to demonstrate
secret injection. It sets `any_errors_fatal: false` and `ignore_unreachable: true` so an
offline host is reported on its own rather than ending the run for every other host, and it
ends early on the host running the app (`hlm_self_managed`).

## Local development

```bash
docker compose -f docker-compose.local.yml --profile ansible up -d --build
```

Then set `ANSIBLE_RUNNER_ENABLED=true` and `ANSIBLE_SIDECAR_TOKEN` in the app environment and
open `/automation`. The route is not linked from the navigation while the feature is behind a
flag.

## Tests

```bash
bun run setup:ansible-sidecar   # once: creates ansible-sidecar/.venv from requirements-dev.txt
bun run test:ansible-sidecar    # cd ansible-sidecar && .venv/bin/python -m pytest
```

Deliberately outside `bun run test:all`, which must not require a Python virtualenv. CI runs
the suite in its own `ansible-sidecar` job on Python 3.13, matching the image.

The suite needs no Docker daemon, no SSH target, and no network. It does need the pinned
`ansible-runner` installed, because `tests/test_runner_contract.py` drives the sidecar's
callbacks through the real `ansible_runner.runner.Runner` instead of a stand-in. A stand-in
would have been written from the same reading of the API as the sidecar, so it would have
agreed with the `status_handler(status, _runner_config=None)` signature that silently killed
the runner thread on every run: `Runner.status_callback` passes `runner_config=` as a keyword.
Layout: `test_runner_contract.py` (runner callback contract), `test_runs_registry.py`
(dispatch arguments, host locking, supervisor), `test_server.py` (auth, request validation),
`test_inventory_script.py` (dynamic inventory).

Tests live in `ansible-sidecar/tests/` rather than the repo's co-located `__tests__/`
convention, which is written for `bun test`. `pytest.ini` puts the rootdir here, and
`.dockerignore` keeps `tests/`, `.venv/`, and `__pycache__/` out of the build context.
