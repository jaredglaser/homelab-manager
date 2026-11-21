---
name: create-migration
description: Create a new numbered SQL migration for this repo's TimescaleDB schema when the user asks for a migration or schema change; follow the repo's migration naming, hypertable, compression, and idempotency conventions.
---

# Create Migration

Use this when the user wants a new SQL migration in `migrations/`.

Before editing:

1. Read `AGENTS.md` for project constraints and migration guidance.
2. Inspect existing files in `migrations/` to verify numeric prefixes are unique, then determine the next zero-padded number. If duplicates exist, report the ordering conflict before creating a new migration.
3. Read nearby migrations that touch the same table or domain so the new file matches local patterns.

## Required conventions

- Name files `NNN_description_in_snake_case.sql`.
- Use `IF NOT EXISTS` or `if_not_exists => TRUE` for idempotency.
- Use `TIMESTAMPTZ` for time columns.
- Take the highest migration number on `main` AND on every open PR. The collision guard only sees one working tree, so two branches can each add `033_*.sql` and both pass CI until the second merges. Never renumber an applied migration (the ledger keys on the exact filename), and never delete one without listing it in `ACKNOWLEDGED_REMOVALS` (see `AGENTS.md` gotcha 23).
- For new time-series tables, follow the three-tier retention cascade pattern from migrations 030-032: a raw hypertable (24h retention), a `_1m` materialized view (30d retention), and a `_1h` materialized view (kept forever), each with its own compression policy (`_1m` compresses chunks older than 7d, `_1h` older than 30d).
- Keep non-time-series tables simple; do not add hypertable/compression boilerplate unless the table stores time-series data.
- If a new `BIGINT` column will be read through `pg`, add a short SQL comment when downstream code will need `Number(...)` coercion.

## Hypertable checklist

For new stats tables, the migration should normally include:

1. `CREATE TABLE IF NOT EXISTS ...`
2. `SELECT create_hypertable(..., if_not_exists => TRUE);`
3. `ALTER TABLE ... SET (timescaledb.compress, ...)`
4. `SELECT add_compression_policy(..., if_not_exists => TRUE);`

Segment compression by the columns used for typical host/entity filters, and order by the hypertable's actual time column descending (for example, `time DESC` or `at DESC`).

## Delivery

- Create the migration file rather than just drafting SQL in chat.
- Report the created filename.
- If the change implies code or docs updates outside `migrations/`, call that out explicitly.
