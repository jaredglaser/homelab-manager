# Playwright Test Plan

End-to-end tests run against the real frontend with [MSW](https://mswjs.io)
standing in for the backend. Two static production builds are served (see
`playwright.config.ts`):

- **`demo`**: the public demo build (`VITE_DEMO_MODE=true`). MSW is always on and
  the demo-only UI is active (banner, disabled terminal). Smoke coverage only, so
  the deployed demo never silently breaks.
- **`app`**: the real, non-demo build with MSW enabled via `VITE_ENABLE_MSW=true`.
  Exercises production code paths and is the target for deep flows. Tests layer
  per-scenario response overrides on top of the shared mocks with `page.route`
  (`overrideServerFn` in `e2e/fixtures.ts`).

Both share the handlers in `src/lib/mock`, so a scenario authored once renders in
the demo and can be reshaped per test.

## What belongs in Playwright (and what does not)

Unit tests (`bun test`) already cover pure logic, hooks in isolation, row
converters, schema validation, and component rendering with injected props. They
run in Happy-DOM, so they cannot exercise: real layout and overflow, the service
worker, EventSource streaming end to end, canvas/WebGL charts, the virtualizer's
real measurement, cross-tab broadcast, focus/scroll, or multi-step navigation
with live data.

Playwright is worth the cost only when a test needs one of those. The flows below
are chosen on that basis. Each notes the MSW/`page.route` setup that drives it.

## App target: deep flows

### Docker
1. **Live stats stream updates the table.** Stat values and sparklines change over
   successive SSE frames without a reload; the row order stays stable (Map
   ordering gotcha). Drives `/api/docker-stats` at 1s cadence.
2. **Host → container expansion with detail panel.** Expanding a host row reveals
   the nested container DataTable inline; the whole row is the click target. Two
   hosts, each with its own container set.
3. **Virtualization threshold.** A host with 150+ containers switches to the
   virtualizer; rows recycle on scroll and sparkline accumulators survive
   remounting (entity-keyed state). Override the inventory stream with a large
   generated set via `page.route`.
4. **Container lifecycle actions.** Start/stop/restart buttons call
   `controlContainer`; assert optimistic UI, the success toast, and the inventory
   reflecting the new state. Override `controlContainer` to reject and assert the
   error toast plus rollback.
5. **Container detail modal: logs + terminal.** Open a container, confirm the log
   backlog renders then live lines append (`/api/docker-logs/$id`,
   `backlog_done`), and the xterm terminal mounts. Demo path uses the demo
   terminal hook.
6. **Icon picker.** Assign and clear a service icon; the icon persists under the
   service-key entity across a simulated container recreation (override the
   inventory to swap container ids for the same service key).
7. **Stale / degraded stream.** Drop the SSE connection mid-session
   (`page.route` aborts `/api/docker-stats`); rows mark stale and the hook
   reconnects with backoff when the route is restored.

### Stacks
8. **Deploy lifecycle.** Trigger a deploy, watch status transition via
   `/api/stack-status`, then resume/reject a pending deploy and confirm
   `deploy_history` updates. Override `triggerDeploy`/`resumeDeploy` for the
   in-progress and failed branches.
9. **Compose editor (Monaco).** Edit YAML, trigger validation/schema hints, save
   (`saveComposeFile`); assert the dirty-state guard and success path.
10. **Variables panel.** Add, edit, reveal, and delete stack variables; assert
    secret values are masked until revealed (`getVariableValue`).
11. **Stack control (start/stop/restart at stack and service scope).** Override
    `controlStack` for both scopes and the failure branch.

### ZFS
12. **Pool → vdev → disk hierarchy.** Expand the tree (`getSubRows`); indent and
    per-level rollups render; live stats stream into nested rows.

### Proxmox
13. **Node → guest expansion** with live stats and the REST-polling cadence
    mirrored by `/api/proxmox-stats`.

### Settings
14. **Managed hosts.** Add a host (verify → enroll), run a health check, and
    remove it; assert the public-key enrollment copy and error states by
    overriding `verifyHost`/`checkHostHealth`.
15. **Live settings sync.** Change a setting in one tab and assert a second tab
    receives it via `/api/settings` (`NOTIFY settings_change` is simulated by the
    settings stream). Cross-tab is impossible to assert in unit tests.
16. **Auth management visibility.** With a non-synthetic session
    (`getSession` override), role-gated cards appear; viewer vs admin differ.

### Cross-cutting
17. **Auth redirect.** Override `getSession` to return null and assert the
    redirect to `/login`; a valid session lands on `/docker`.
18. **Color mode + palette.** Toggle light/dark with no flash (the pre-paint
    inline script) and switch selectable palettes; assert background-derived
    tokens update.
19. **Mobile layout.** Below 1024px the sticky toolbar shows one metric group at a
    time (ResizeObserver, not media queries); toggle CPU/RAM ↔ Disk ↔ Net.
20. **Deep-link + back/forward** across `/docker`, a container modal, `/stacks`,
    and a stack detail; state and scroll restore correctly.

## Demo target: smoke only

- The public demo boots, shows the demo banner, and renders mocked Docker data
  (this exists today as `e2e/demo.demo.e2e.ts`).
- Each top-level route (`/docker`, `/stacks`, `/zfs`, `/proxmox`, `/settings`)
  loads without an error boundary.

## Conventions

- Spec files: `*.e2e.ts` run on `app`; `*.demo.e2e.ts` run on `demo`.
- Prefer role/text queries over test ids; add `data-testid` only where the DOM is
  ambiguous.
- Drive scenarios by overriding the shared mocks (`overrideServerFn`, `page.route`
  for SSE) rather than adding bespoke demo data, so the demo stays representative.
