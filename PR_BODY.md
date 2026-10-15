## Problem

Two service_key namespaces existed for the same column of identity data. The history fan-out in `getContainerHistory` resolves sibling container IDs through `entity_metadata` rows where `key='service_key'`, joined on exact value equality. `AgentStatsCollector` wrote that key as the container name, while `docker_container_events` grouped events by the label-derived key from `computeServiceKey` (`com.docker.compose.project` + `com.docker.compose.service`, fallback name). For any compose container, event grouping and history fan-out disagreed, and once a container's name changed across a recreation the old and new incarnations never linked again: the data was in the database, the join just could not see it.

## Changes

- `ContainerInventoryCollector.registerContainerMetadata` now writes `service_key = computeServiceKey(labels, container.name)` and is the sole writer of that key. The `'labels' in container` guard is kept; init and upsert frames both carry labels today, so the guard only matters if a frame ever ships without them.
- `AgentStatsCollector.registerContainer` no longer writes `service_key`; it keeps writing name and image so a stats-first arrival still carries identity data.
- Migration 038 (`038_unify_container_service_keys.sql`) rewrites existing name-based `service_key` values to the label-derived key taken from each container's newest `docker_container_events` upsert row, and moves `key='icon'` rows from the `host/oldKey` entity to `host/newKey` when the target has no icon yet. Runs inside the standard transaction.
- `scripts/migration-verify` grows `assertServiceKeyUnification`: seeded events and metadata cover a container whose key changed between two events, a destroy-latest container, a replica pair, an unlabeled container, and a container with no event row at all; the migration's own SQL is rerun post-seed and the rerun must insert nothing.

## Known limits

- Containers with no `docker_container_events` row at all keep their name-based key: nothing in the database can derive their labels. This affects only containers that predate the inventory collector entirely.
- The rewrite source is the newest row carrying a service_key (the latest upsert). A container whose newest event is a destroy keeps the key of its last known upsert state; destroy rows store a null service_key and are never a source.
- Old icon rows stay on the old key entity (copy semantics, matching `migrateServiceIcon`), since another incarnation may still hold the old key.

## Verification

- `bun run typecheck:all`: clean (root, agent, agent-updater).
- `bun run test`: 4001 pass, 0 fail across 271 files; coverage lines 98.08% (threshold 98%), functions 94.01% (threshold 94%).
- `bunx eslint` on all touched files: 0 errors.
- `scripts/migration-verify` against a real TimescaleDB (timescaledb image at the CI-pinned digest, container `migverify-ts`): fresh 23/23 checks passed; upgrade 226/226 (including the 14 new service_key unification checks); idempotent 3/3.
- Pushed commit `92c8c9856e1e47d0ab42fbc514fb359bdd85d6bc` is Verified (`gh api .../commits/<sha> --jq .commit.verification.verified` prints true).

## Decisions and why

1. **The inventory collector is the sole service_key writer; the stats collector drops the key entirely.** The stats SSE stream's `ComputedStats` carries containerId, containerName, image, and metrics but no labels, so it cannot derive the compose key and any key it wrote would re-create the divergent namespace. Writing the name "for safety" is exactly the bug being fixed: the fan-out joins on exact value equality, so two writers with different derivations split every compose container's history into two groups.
2. **Migration 038 sources the rewrite from `docker_container_events`, not from labels re-derived in SQL.** The event table already stores the exact key the collector computes (`computeServiceKey` output, sanitization included), so reusing it guarantees the rewritten values match what the collector will write on the next reconcile. The limit falls out of the same choice: a container with no event row has no key on record, so it stays name-based and stays documented as unlinked.
3. **Replicas sharing compose labels now link and merge histories.** This is a semantics change, not a side effect: two containers with different names but the same `project/service` key were previously two unrelated identity groups and now fan out into one merged series. That is the intended fix for the rename problem and is the same grouping the event table already used.
4. **A new migration 038 instead of editing 037.** 037 may already be applied in deployed databases, so editing it would silently skip them; its ledger row would match a different file. 037 itself stays untouched and keeps its name-based backfill semantics, which 038's rewrite immediately corrects for containers that have event rows.