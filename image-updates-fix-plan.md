# Image-Update Hardening Plan

Status: DRAFT v3, decisions recorded. Temporary file; delete after the work lands.
Branch strategy: EXTEND PR #588 — all phases land as additional commits on `wt/manual-check`.

## Decisions (owner, final)

1. Give-up policy: SKIP the check when the snapshot has not converged after 3 minutes; log and drop the waiter. A stale pre-update verdict is never persisted.
2. PR strategy: extend #588 on `wt/manual-check`; no stacked PR.
3. `rcN` → `rc.N` normalization: NO (semver-correct already for those inputs).
4. Persisted verdicts written under the old trust rule: ACCEPT the ≤12h serving window; no blanket clear.
5. M5 duplicate checks: PENDING — see the explanation owed to the owner (options: accept duplicate checks per tick [recommended], dedup within a tick, or defer to a future schema change).

## Context

Three review agents audited the image-update feature after the tag-comparison bug was fixed (commit 84c251f1: constraint tags like `2-alpine` parse as major-only versions, so updates were judged against a version the container had already moved past). The review found two more instances of that class plus state-lifecycle and UI gaps. This plan addresses all of them. Two verification agents then checked the draft against the code; their corrections are incorporated (notably: the semver pin and types, the Range construction for prerelease constraints, the trust-rule example, and the cache-invalidation matrix).

Findings being addressed (severity-ordered):

| # | Finding | Workstream |
|---|---------|------------|
| H1 | 304 short-circuit not bound to the digest it was validated against → false "up to date" | W2 |
| H2 | Post-update re-check races the inventory snapshot → stale verdict persisted up to 12h, no broadcast | W3 |
| H3 | One errored row forces live checks of the whole stack on every panel read, uncached | W3 |
| M1 | Declared-version edge cases: build metadata unparseable; cross-scheme labels trusted unconditionally | W1 |
| M2 | Footer asserts an update under a "Check failed" badge (null-verdict branch missing) | W4 |
| M3 | `skipUpdateCheckRef` in `StackEditorForm.tsx` never resets → later Update dispatches with no fresh check | W4 |
| M4 | Changelog cache keyed without the resolved repo → stale releases up to 1h after an override change | W4 |
| M5 | Refresher merges labels across stacks sharing an image ref (grouped by host/image) | W2+W3: full fix, schema rekey |
| M6 | Mock drift: `changed: 0` hardcoded; summaries omit `currentVersion`/`checkedAt`/`versionSource` | W4 |
| L1 | `1.0-testing` misclassified as prerelease; prerelease+variant combos misclassified (parse as one blob) | W1 |
| L2 | Stack-wide vs single-image check race; duplicate publishes | W3 |
| L3 | `deleteMissing` wipes all rows if a tick sees an empty snapshot | W2 |
| L4 | Refresher startup fails once and never retries | W2 |
| L5 | Raw fetch errors (`TypeError: Failed to fetch`) leak into changelog copy; renamed-repo 301s fail | W4 |
| L6 | Release filter drops the constraint's variant but not the release tag's variant | W1 |
| L7 | 404 copy wrong for private repos | W4 |
| L8 | `check-run.ts` catch-path summary omits `currentVersion` | W4 |
| L9 | Footer empty-row gap when `checkedAt` absent | W4 |

Verified clean by review, not touched: `parseImageRef`, GitHub pagination/Link handling, prerelease rule end to end, the ETag-persist invariant itself, repository upsert semantics, dedup-map poisoning (none), broadcast service, `refresher-config.ts`, `BoundedCache` (gaining `delete` in W3). No e2e/Playwright spec touches the update dialog or check flow, so the mock changes cannot break e2e. No AGENTS.md rule or gotcha changes in any workstream.

## Workstream 1 — semver migration + one normalizer (fixes M1, L1, L6)

Adopt `semver@7.8.5` (exact pin — the version bun.lock already resolves under typescript-eslint, so the package itself is no new download) plus `@types/semver` as a new exact-pinned devDependency (semver 7.8.5 ships no types; strict TS fails without it). `coerce` is banned: it drops prereleases (`1.0.0-rc.1` → `1.0.0`), fabricates versions from hex digests, and loses pinned-axis info.

### Normalizer

`normalizeVersion(raw)` replaces `parseVersionTag` (same output shape, plus a precompiled `semver.SemVer` of the zero-padded core). Pipeline, in order — the ordering is load-bearing:

1. Custom guards kept: trim, empty, `sha256:` rejection (never delegate to semver's null — `coerce`/extraction on a hex digest can fabricate a version), leading-digit check, case-insensitive `v`/`V` strip (semver only accepts lowercase `v`).
2. Build metadata stripped: drop everything from `+` onward (docker tags cannot contain `+`, so this only affects label- and release-tag-derived strings; semver says build metadata is ignored for precedence anyway).
3. Dash-suffix split into segments, classified per segment BEFORE semver sees the string (note: `semver.parse('2-alpine')` is null, but the padded core `2.0.0-alpine` parses with `alpine` as a prerelease — the split must happen first so variants never become prereleases):
   - first segment matching the prerelease pattern starts the prerelease;
   - a trailing maximal run of vocabulary segments becomes the variant;
   - no prerelease match → whole suffix is the variant (today's behavior);
   - unknown trailing segments stay in the prerelease (conservative fallback).
   - Vocabulary (closed set, only disambiguates combos): `alpine`, `slim`, `bookworm`, `bullseye`, `buster`, `stretch`, `trixie`, `jammy`, `noble`, `focal`, arch names (`arm64`, `armv7`, `armhf`, `aarch64`, `amd64`, `386`, `riscv64`, `ppc64le`, `s390x`), plus `/^alpine3\.\d+$/`.
   - Examples: `1.0.0-rc.1-alpine` → prerelease `rc.1` + variant `alpine`; `1.0.0-rc.1-foo` → prerelease `rc.1-foo`, variant null; `2.11.7-slim-bookworm` → variant `slim-bookworm`.
4. Numeric core: 1–3 dot parts, `/^\d+$/` each (records which axes the tag pins; `minor`/`patch` nullability is load-bearing), padded to X.Y.Z, then `semver.parse(padded)` — validates and yields spec prerelease arrays.
5. Unparseable → null; caller decides (floating path, tag fallback).

### Constraint as compiled Range

`TagConstraint` stays the source of truth (variant and pinned-axis null-ness cannot live in a range) and gains an internal compiled `semver.Range` built once per check with `includePrerelease: constraint.allowPrerelease`. Range shapes (the draft's shapes were wrong when `allowPrerelease` is true — semver's same-tuple rule excludes prereleases of the lower bound unless the bound carries `-0`):

- patch pinned, allowPrerelease false → exact `X.Y.Z`
- patch pinned, allowPrerelease true → `>=X.Y.Z-0 <X.Y.(Z+1)-0`
- minor pinned → `>=X.Y.0[-0] <X.(Y+1).0-0` (the `-0` lower bound only when allowPrerelease)
- major only → `>=X.0.0[-0] <(X+1).0.0-0`

The `-0` upper bounds exclude the next axis's prereleases (`3.0.0-rc.1` fails a `:2` pin even with `includePrerelease: true`), reproducing the current major gate. The implementation must include an equivalence test table covering every existing `matchesConstraint` case PLUS the prerelease-constraint cases the draft got wrong (`2.0.0-rc.2` against a patch-pinned prerelease range, `2.1.0-rc.1` against a minor-pinned prerelease range). `comparePrerelease` is deleted (`semver.compare` implements the spec, including `rc1` > `rc.2`, which is semver-correct for those inputs).

### Call-site changes

- `registry-client.ts`: single-pass tag walk producing `latestMatching` and `latestOverall` (today it walks twice); verdict uses `semver.compare` on the precompiled `SemVer`s; `Range#test` per candidate against the precompiled Range (never `satisfies(string, string)` per tag).
- `ImageUpdateDialog.tsx` (L6): release filter drops the variant on BOTH sides — the constraint already does; the release tag's parsed variant is nulled too (`{ ...parsed, variant: null }`), so repos publishing `v2.11.7-alpine` release tags match. The comment claiming "GitHub tags never carry Docker variants" is replaced by the real invariant: the Docker variant selects a build, so it cannot match upstream release tags.
- `mock/functions/stacks.functions.tsx`: mechanical rename; `raw` survives on the normalized object.
- Final commit of W1 deletes the deprecated `parseVersionTag` alias and the helpers folded into the single-pass walk (`compareVersions`, `comparePrerelease`, `newestVersionTag`, `newestTagMatchingConstraint` in their old form) — no dead code survives.

### Trust rule + versionSource (fixes M1, feeds W4's badge)

The trust rule is extracted into a named pure helper (home: `version.ts`), because it is needed at TWO sites (see below):

```
resolveRunningVersion(constraint, labelVersion, tagFallback):
  trusted = labelVersion !== null
    && labelVersion.major === constraint.major
    && (constraint.minor === null || labelVersion.minor === constraint.minor)
    && (constraint.patch === null || labelVersion.patch === constraint.patch)
  → { current: trusted ? labelVersion : tagFallback, versionSource: trusted ? 'label' : (tagFallback ? 'tag' : null) }
```

- Site 1: `checkImageUpdateWithMeta` after the tag walk (live checks, manual checks, refresher). Digest pins have no constraint and never reach the helper: `currentVersion`/`versionSource` stay null there, and F1's digest-pin footer sentence covers the UI.
- Site 2: the read-time enrichment in `image-update-service.ts` — BOTH the allFresh fast path and W3's per-group fast path call the same helper when building summaries from persisted rows (constraint from the image, labelVersion from snapshot labels, tagFallback from the row's `currentTag`). This is what makes the Version-unknown badge consistent between cached and live reads.

Behavior changes, stated precisely:
- A label that disagrees with the pinned major is no longer trusted. For a major-only tag (`redis:7-alpine` + label `6.9.0`) the verdict is UNCHANGED (current falls back to 7.0.0, newest matching 7.4.1-alpine still wins → `updateAvailable: true`) — but the badge now honestly reads "Version unknown" instead of a confident wrong "Current: 6.9.0". The false-positive ELIMINATION happens when the tag pins minor/patch (`redis:7.4.1-alpine` + label `6.9.0` → current 7.4.1 → `false`).
- Build-metadata labels (`7.4.1+build.5`) now parse and are trusted.
- `currentVersion` and `versionSource` are OPTIONAL summary fields derived at READ time; neither is persisted, no DB column. Deterministic from (image, labels, row.currentTag), so cached and live reads agree.

### Tests

- `version.test.ts` rewritten around `normalizeVersion` with a table of real-world tags: `2`, `2-alpine`, `2.11.7-alpine`, `v2.11.7`, `V3`, `2.11.7+build.5`, `2024.11.0`, `24.04`, `7.4`, `7`, `1.0.0-rc.1`, `1.0.0-rc.1-alpine`, `1.0.0-rc.1-foo`, `latest`, `main`, `sha256:…`, `1.2.3.4`; plus the Range equivalence table (all existing `matchesConstraint` cases + the prerelease-constraint cases).
- `registry-client.test.ts`: existing verdict tests survive; new: label disagreeing with pinned major on a major-only tag → `true` + `versionSource: 'tag'`; same on a patch-pinned tag → `false`; build-metadata label → trusted + `'label'`; pinned-minor disagreement → fallback.
- Dialog tests: add a release-tag-carrying-variant case and a different-variant case (both sides dropped).
- Docs: `docs/architecture.md`'s label-as-truth description and the registry-client comment updated to describe the trust rule.
- Coverage note: before W1 lands, check whether `bun test --coverage` counts node_modules (the 98/94 gates pass today with react in the graph, so probably not); if semver's files count, add a `coveragePathIgnorePatterns` entry; otherwise drop this note.

## Workstream 2 — per-stack verdict rows + ETag bound to its digest + refresher hygiene (fixes H1, M5, L3, L4)

### Migration 043: rekey to (host, stack, image) + manifest_digest

Owner decision: FULL FIX for M5 — verdict rows are keyed per stack. One migration carries both the rekey and the etag-digest column. `migrations/043_image_update_checks_per_stack.sql`:

```sql
ALTER TABLE image_update_checks
  ADD COLUMN IF NOT EXISTS stack TEXT,
  ADD COLUMN IF NOT EXISTS manifest_digest TEXT;

WITH snapshot AS (
  SELECT DISTINCT ON (host, container_id)
    host, container_id, event_type, image, compose_project
  FROM docker_container_events
  ORDER BY host, container_id, at DESC
),
live AS (
  SELECT DISTINCT host, compose_project AS stack, image
  FROM snapshot
  WHERE event_type = 'upsert' AND compose_project IS NOT NULL AND image IS NOT NULL
)
INSERT INTO image_update_checks
  (host, image, stack, current_tag, latest_matching_tag, latest_overall_tag,
   update_available, source_repo, error, last_error_at, etag, checked_at, manifest_digest)
SELECT old.host, old.image, live.stack, old.current_tag, old.latest_matching_tag,
   old.latest_overall_tag, old.update_available, old.source_repo, old.error,
   old.last_error_at, old.etag, old.checked_at, NULL
FROM image_update_checks old
JOIN live ON live.host = old.host AND live.image = old.image
WHERE old.stack IS NULL;

DELETE FROM image_update_checks WHERE stack IS NULL;

ALTER TABLE image_update_checks ALTER COLUMN stack SET NOT NULL;
ALTER TABLE image_update_checks DROP CONSTRAINT image_update_checks_pkey;
ALTER TABLE image_update_checks ADD PRIMARY KEY (host, stack, image);
```

- The snapshot CTE replicates `getCurrentSnapshot` verbatim (latest event per container; destroy-latest containers excluded by the `upsert` filter, matching runtime callers). Each old `(host, image)` row is expanded per stack that currently runs that image; rows whose image runs nowhere are DROPPED (they were unreachable by `deleteMissing` anyway; cost: one extra HEAD for a floating tag, one live check for tag verdicts — self-healing within one interval). `manifest_digest` copies as NULL (no backfill possible; null digest makes the etag gate fail → one full HEAD).
- `stack` becomes NOT NULL: null-compose containers are outside the feature's domain by construction.
- Fresh install: empty events table → expansion inserts nothing, nothing fails.
- 043 is free (042 is highest on disk and on every open PR head, verified via git ls-tree; re-verify at push per gotcha 23). `scripts/migration-verify/assertions.ts` column-set gains `stack, manifest_digest`, plus a NEW PK assertion (`pg_get_constraintdef` contains `(host, stack, image)`), plus a seed scenario: pre-043 rows expanded per running stack byte-identical, orphan rows gone.
- Rollout/rollback: only the worker runs migrations (`src/worker/collector.ts`); during the window before the worker's boot lands them, new web code against the old schema fails reads (caught, falls back to live checks) and writes (best-effort absorbed; a manual check may error transiently) — the documented operational model updates both images together. Rollback is one-directional: old code reads the new table fine but every upsert fails on the missing `(host, image)` constraint, so a rollback needs `UNIQUE (host, image)` re-added manually or a backup restore (worth a line in the self-hosting upgrade docs).

### Repository

- `getByHost` is DELETED; the panel read path gets `getByStack(host, stack)` (both read callers are already stack-scoped; a host-wide image-keyed read would reintroduce the cross-stack bug at read time). `rowsByImage` keyed by bare image stays correct because the query is stack-scoped.
- `deleteMissing(keep: {host, stack, image}[])` — three parallel arrays zipped pairwise via `unnest($1::text[], $2::text[], $3::text[])`; empty keep list still deletes everything (the empty-snapshot guard covers that hazard).
- `upsertSuccess`/`upsertFailure`: conflict target `(host, stack, image)`; `stack` param added; `manifestDigest` in the success INSERT/UPDATE from one `EXCLUDED` row (no torn pairs). `upsertFailure` otherwise untouched (preserves last-good tags and pair).
- Types: `ImageUpdateCheckRow`/`ImageUpdateCheckSuccess` gain `stack: string`; row gains `manifestDigest: string | null`. `getAll` and `isRefreshDue` need no SQL change.

### Check flow

`checkImageUpdateWithMeta` gains a 5th param `storedDigest`; `ImageUpdateCheckMeta` gains `digest`. Floating-tag branch: the ETag is sent only when `storedDigest === imageDigest`; otherwise a full HEAD. Persist matrix:

| Outcome | etag | manifest_digest |
|---|---|---|
| 304 (gate passed) | keep stored | keep stored |
| 200, digest === imageDigest | remote.etag | remote.digest |
| 200, digest differs (update available) | null | null |
| 200 without Docker-Content-Digest | null | null |
| 404 / error | null | null |
| versioned-tag branch (unchanged) | null | null |
| no local digest (inconclusive passthrough) | keep stored etag | keep stored digest |

This matrix describes the pair RETURNED by `checkImageUpdateWithMeta`. Errored checks still persist via `upsertFailure`, which ignores the returned pair and preserves the last-good etag/digest through outages. The gate strengthens the existing "etag only after an up-to-date verdict" invariant: a 304 now additionally proves the stored manifest is still what the containers run. One-time cost after deploy: every FLOATING-TAG row (the only rows that touch manifests) does one extra HEAD; versioned-tag rows are unaffected.

### Refresher hygiene

- Empty-snapshot guard: `runTick` early-returns (logged) when `groups.length === 0` — an empty snapshot is far more likely an ingestion failure than a truthful "no compose containers"; `deleteMissing([])` currently deletes every row including etags.
- Startup retry: wrap `startImageUpdateRefresher`'s body in the existing `retry()` helper with explicit options (`maxAttempts: Infinity`, `isRetryable: () => true`, `baseMs: 2_000`, `capMs: 60_000` — the helper's defaults are 500ms/30s and require maxAttempts and isRetryable), logging each attempt; the module ref is assigned only after a successful start. Panel reads need no change — while startup retries they take the live-check write-through path, and `start()` anchors from the wall clock afterward with no catch-up storm.

### Call-site changes

- `update-refresher.ts`: prior-map key and lookups become `host/stack/image`; keep-list becomes triples; `start()` unchanged (`getAll` is key-agnostic).
- `check-run.ts`: `upsertFailure(group.host, group.stack, group.image, ...)`, `upsertSuccess` gains `stack: group.stack` (+ `manifestDigest`); changed-detection now compares each stack's verdict against its OWN history — changed events name the stack whose verdict actually moved (today the first stack's write poisons the second's `changed` comparison).
- `image-update-service.ts`: `getByStack(host, stack)`; write-through passes `stack`.
- `manual-check.ts`: `getByStack(host, stack)`.
- `snapshot-groups.ts`: grouping key becomes `host/stack/image` — the cross-stack merge problem disappears at the group level. REMAINING EDGE (explicit): within one stack, two containers sharing an image ref still merge, and the source-repo-label preference still picks one label set; that is compose semantics (same stack, same image = one registry question), not a rekey gap.
- Broadcast: `ImageUpdateChangedEvent` already carries `stack`; no shape change.

### Tests

304-not-honored-when-digest-mismatches (headline), legacy row without digest does one full HEAD, persist-matrix assertions, empty-snapshot guard, repository mapping/upsert/conflict-target updates, refresher keep-list triples + the headline regression test (one image under two stacks → two registry calls, two upserts, one changed event naming the stack whose verdict moved), service two-stacks-read-their-own-rows test, manual-check different-stack prior ignored, `migration-verify` column-set + PK assertion + seed expansion scenario, docs (`docs/architecture.md` "one row per (host, stack, image) (migration 043)").

## Workstream 3 — convergence-gated post-update check + read path (fixes H2, H3, L2)

### Post-update watcher (replaces the blind 5s timer)

New `src/lib/image-updates/post-update-watcher.ts`; `pipeline.ts`'s `onUpdateSuccess` hook gains a `completedAt` timestamp and arms a waiter instead of scheduling a check.

- Convergence test: `loadStackContainers(stack, host)` and require `max(row.at) >= completedAt - CLOCK_SKEW_MS`. `CLOCK_SKEW_MS = 90s` is a starting guess whose adequacy depends on whether `at` is agent event time or server ingest time — verify during implementation and record the finding (listed in Risks).
- Signals: first test at +5s, then every 10s poll, plus an early test driven by the existing `dockerInventoryBroadcastService` (already LISTENs to `docker_container_change`, whose payload carries host/composeProject/image/digest), debounced 2s so N recreated containers produce one check.
- **Subscription lifecycle (final matrix):** the NOTIFY subscription is PERMANENT (subscribed at watcher init, never unsubscribed), serving two jobs: (a) early convergence tests while a waiter is armed, and (b) keyed summary-cache invalidation on ANY matching upsert regardless of waiters. The refresher's whole-cache clear on its tick stays. There is no waiter-scoped subscribe/unsubscribe — that draft design could not deliver "snapshot changes are the invalidation source".
- Converged → `runManualImageUpdateCheck(stack, host)` (existing persist + broadcast path), waiter removed.
- **Give-up policy (recommended, needs sign-off): unconverged after 3 minutes → log and drop the waiter WITHOUT running the check.** A verdict from the pre-update snapshot is the bug itself: it would pin "update available" with a fresh `checked_at` and no broadcast. Recovery after a give-up is NOT automatic in the short term: NOTIFY only invalidates caches, it never re-checks — the stale pre-update verdict stands until the next refresher tick (up to 12h) or a manual Re-check. Skipping still beats persisting a wrong verdict.
- Runs in the web server process only (pipeline, refresher, caches, and the LISTEN clients already live there); the worker stays a pure collector. The agent response carries no container ids (`AgentDeployResponse` is `{success, logs}`), so agent-reported gating would require a protocol change — rejected for now.

### Dedup + generation (fixes L2, protects H2)

- In-flight map key becomes `host/stack` (single-image callers join the stack-wide run; their result is filtered to the requested image, and the `checked`/`failed` counts are recomputed from the filtered summaries so a toast never names unrelated images).
- A per-stack generation counter is bumped when a waiter arms; a run whose generation is stale is allowed to settle, then a fresh run starts — a scheduled check can never join a pre-update in-flight run. Identity-guarded `finally` cleanup prevents a chained run from deleting its successor.

### Errored-row fast path (fixes H3)

`getImageUpdateSummaries` classifies per group instead of all-or-nothing:

- serveable(row) = row exists AND `checkedAt` fresh AND (`error === null` OR last-good tags exist — `upsertFailure` preserves tags but a first-ever failure inserts NULL tags, which must still live-check).
- Persisted summaries built from serveable groups via `rowToSummary` PLUS the W1 read-time enrichment helper (currentVersion + versionSource) — stated here so no implementer builds them from `rowToSummary` alone; live checks run only for the rest; results merged and sorted; persist loop covers live results only.
- Cache written when every live-checked summary is error-free (served errored rows are cacheable; a live error still blocks, preserving the outage test).

### Cache invalidation on deploys

- `PipelineDeps` gains `onDeploySuccess`; deploy/teardown success clears the summary cache (whole-cache clear is fine at a 300-entry cap).
- The watcher's permanent NOTIFY subscription calls a keyed `invalidateImageUpdateSummaryCache(host, stack)` on any matching upsert (new `BoundedCache.delete(key)`), making snapshot changes the invalidation source between ticks.

### Cross-stack label merge (M5) — resolved by the W2 rekey

With rows keyed `(host, stack, image)` and groups keyed the same, two stacks sharing an image ref get their own rows, their own verdicts, and their own changed events. The interim refuse-to-merge guard from earlier drafts is dropped — the schema is the fix. Remaining edge (within one stack, shared image ref, divergent labels) is compose semantics, documented in W2.

### Tests

Watcher: debounce coalescing, poll fallback, permanent-subscription invalidation, converged/unconverged/deadline paths, generation bump chaining, single-image join filtering with recomputed counts. Service: errored-serveable row served without registry calls (with currentVersion/versionSource present); first-ever-failure shape still live-checks; mixed stack calls the registry once; cache written/preserved correctly; keyed invalidation. Pipeline: hook signatures, `onDeploySuccess` firing matrix. `BoundedCache.delete`. The existing `schedulePostUpdateCheck` test block in `manual-check.test.ts` is REPLACED by watcher tests (the old timer tests die with the timer).

## Workstream 4 — UI, copy, mocks (fixes M2, M3, M4, M6, L5, L7, L8, L9)

All copy plain-language, pinned verbatim in co-located tests.

- **F1 footer null-verdict branch** (M2): three new sentences before the final else — digest pin: "The registry check can't compare versions for a digest pin. \"Update images\" re-pulls the newest published build of X."; check failed: "The last registry check failed, so this panel can't tell whether an update exists. Use \"Re-check\" to try again; \"Update images\" re-pulls the image either way."; loading: "The registry check hasn't finished comparing versions yet. \"Update images\" re-pulls the newest published build of X." The floating-tag branch stays ahead of these (it never claims a version).
- **F2 Version-unknown badge** (P1): `versionSource === 'tag'` → warning badge `Version unknown` + 12px `CircleHelp` icon, wrapped in the StackContainersPanel tooltip pattern (TooltipProvider/Tooltip/TooltipTrigger with `tabIndex={0}` so keyboard focus opens it; first tap shows it on touch). Tooltip copy: "This image doesn't say which version it is. The check guessed from the tag name, so it may show an update you already have. Nothing is broken. Pinning a full version tag, like 2.11.7, makes this exact." `versionSource === 'label'` (or absent with `currentVersion` set) keeps the muted `Current: X` badge.
- **F3 changelog cache key** (M4): resolve the repo BEFORE the cache lookup; key becomes `host/stack|image|repo-or-dash`. Same 1h TTL and rate-limit shielding; stale-keyed entries evict naturally.
- **F4 friendly GitHub failures** (L5): `redirect: 'follow'` + final-URL host check (same trust boundary as the Link-header check; renamed repos start working). Wrap per-page fetch/parse: timeout → "GitHub took too long to answer, so release notes are unavailable right now. Try again in a moment."; network → "Could not reach GitHub to fetch release notes. Check your network and try again."; malformed → "GitHub returned an unexpected response, so release notes are unavailable right now."
- **F5 404 copy** (L7): "github.com/X has no public releases, so there are no release notes to show. A private repository looks the same from the outside; if the repository exists, publishing releases or making it public fixes this."
- **F7 skipUpdateCheckRef** (M3, `StackEditorForm.tsx`): ref becomes a timestamp; consumed only within 30s; cleared on confirm-dialog cancel and on non-update actions. Expired → fresh check (what the user would want anyway).
- **F8 mocks** (M6): `buildUpdateSummary` gains `currentVersion` (tag-derived, `v` stripped; null for the floating mock image), `checkedAt`, and `versionSource` (one calendar-version mock image gets `'tag'` so the demo exercises the Version-unknown badge); `checkImageUpdates` computes `changed` from a module-level prior-verdict map, and one deterministic image flips on its second check so the demo exercises the stale-verdict confirm flow.
- **F9 catch path** (L8): `checkAndPersistImage`'s catch summary includes `currentVersion` and `versionSource` via the W1 helper.
- **F10 footer gap** (L9): render the Last checked line unconditionally ("Not checked yet" when absent) with explicit mobile row placement.

## Sequencing

Each phase is independently committable and green; order within #588:

1. **W1** semver normalizer (dependency pins → version.ts rewrite with a deprecated `parseVersionTag` alias → registry-client single-pass + trust-rule helper + versionSource → dialog/mock renames → alias/helper deletion).
2. **W2** migration 043 (per-stack rekey + manifest_digest) + etag gate + refresher hygiene (functionally independent of W1; both edit `checkImageUpdateWithMeta`, so linear stacking handles the overlap).
3. **W3** watcher + errored-row fast path + dedup + cache invalidation (needs W1's read-time enrichment helper and W2's `getByStack`).
4. **W4** UI/copy/mocks (F2 needs W1's versionSource; the rest are independent).

Test surface: ~70 new/changed tests across ~11 files (version.test.ts rewrite, registry-client additions, watcher suite replacing the schedulePostUpdateCheck block, service/pipeline/repository updates including the per-stack rekey regression tests, dialog badge/footer/filter cases, mock helper tests, migration-verify PK + seed-expansion assertions), plus docs updates in `docs/architecture.md` (W1 label-trust, W2 per-stack rows + etag/digest + guard, W3 errored-row read path) and `docs/development.md` (W2).

## Risks

- Trust rule changes verdicts for images whose labels disagree with pinned minor/patch (intended, user-visible; call out in the PR description). Persisted rows written under the OLD rule keep serving their old verdict until the refresher re-checks them (≤12h, accepted). Note the Version-unknown badge only warns about false positives; a stale "up to date" verdict can hide a real update — that residual risk is what the accepted 12h window carries.
- One extra HEAD per floating-tag row after 043 deploys (one-time; versioned-tag rows unaffected).
- Give-up policy leaves "update available" showing for an offline host until the next 12h tick or a manual Re-check (decided: skip over persisting a wrong verdict).
- `CLOCK_SKEW_MS = 90s` is an unverified guess; verify `at` provenance (agent event time vs server ingest time) during W3 implementation.
- Migration 043 number collision with a concurrently opened PR — rebase before merge (guard test only sees this tree).
- Migration window: only the worker runs migrations, so new web code can hit the old schema for seconds at boot (reads fall back to live checks; writes are best-effort absorbed; a manual check may error transiently). The documented operational model updates both images together; no code mitigation.
- Rollback of 043 is one-directional: old code reads the new table but upserts fail on the missing `(host, image)` constraint — a rollback needs `UNIQUE (host, image)` re-added manually or a backup restore (documented in the self-hosting upgrade docs).
- Variant vocabulary is a maintained list; unknown segments fall back to today's conservative behavior, so staleness degrades gracefully.
- The watcher's permanent NOTIFY subscription keeps the docker-inventory LISTEN client (one dedicated DB connection) alive in the web server even with zero browsers connected; today it lives only while a dashboard client subscribes. Accepted cost.
- Coverage gate: verify whether node_modules counts under `bun test --coverage` before W1 (see W1 tests).

## Open decisions for the owner

1. RESOLVED: skip the check on unconverged snapshot.
2. RESOLVED: extend #588.
3. RESOLVED: no `rcN` normalization.
4. RESOLVED: accept the ≤12h window for old-rule persisted verdicts.
5. RESOLVED: FULL FIX — migration 043 rekeys `image_update_checks` to `(host, stack, image)` (see W2).
