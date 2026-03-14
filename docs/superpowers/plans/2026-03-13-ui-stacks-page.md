# UI Stacks Page Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/docker/stacks` page for Docker stack management. Users view, edit, deploy, and monitor Docker Compose stacks through a virtualized list with expand/collapse detail, a Monaco compose editor with variable detection, deploy controls, and deploy history.

**Architecture:** A new TanStack Router page at `/docker/stacks` (SPA mode, `ssr: false`). Data flows through server functions (`@/data/stacks.functions`) that call the deploy pipeline and git management APIs. The page reuses the existing ContainerTable expand/collapse pattern (div-based grid, `useWindowVirtualizer`), ContainerLogViewer (xterm.js for deploy logs), and IconPickerDialog. Monaco editor is dynamically imported via `React.lazy` to avoid bundle bloat. Feature-gated behind `VITE_DOCKER_MANAGEMENT_FEATURE_FLAG`.

**Tech Stack:** React 19, TanStack Router, TanStack Query, MUI v7, TailwindCSS v4, Monaco Editor (lazy), Jotai (settings), xterm.js (deploy logs)

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 4: UI & Frontend)

**Conventions (from CLAUDE.md):**
- TailwindCSS ONLY for styling. Never `sx` props. Use `!` prefix to override MUI defaults.
- Theme CSS variables for all colors, never hardcoded hex.
- `@/` imports for all src files. Relative paths only in `__tests__/`.
- `ssr: false` on all routes. Never edit `routeTree.gen.ts`.
- AppShell in root layout only. QueryClient singleton in `AppShell.tsx`.
- Dynamic `await import()` for server-only modules inside server functions.
- div-based rows (not `<table>/<tr>/<td>`).
- Tests use `bun:test` + Happy-DOM + Testing Library. Tests in `__tests__/` co-located.

---

## Chunk 1: Feature Flag Infrastructure & CSS Variables

### Task 1.1: Add deploy status CSS variables to App.css

**Files:**
- Edit: `src/App.css`

- [ ] **Step 1: Add deploy status CSS variables to light mode block**

In `src/App.css`, add the following CSS variables inside the existing `:root` block, after the `--indicator-late` line:

```css
  --chart-deploy-success: #22c55e; /* green-500 */
  --chart-deploy-failed: #ef4444; /* red-500 */
  --chart-deploy-pending: #f59e0b; /* amber-500 */
  --chart-deploy-in-progress: #3b82f6; /* blue-500 */
```

- [ ] **Step 2: Add deploy status CSS variables to dark mode block**

In `src/App.css`, add the following CSS variables inside the existing `[data-color-scheme="dark"]` block, after the `--indicator-late` line:

```css
  --chart-deploy-success: #4ade80; /* green-400 */
  --chart-deploy-failed: #f87171; /* red-400 */
  --chart-deploy-pending: #fbbf24; /* amber-400 */
  --chart-deploy-in-progress: #60a5fa; /* blue-400 */
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck`

- [ ] **Step 4: Commit**

```
feat: add deploy status CSS variables for stack management
```

### Task 1.2: Add feature flag utility

**Files:**
- Create: `src/lib/utils/feature-flags.ts`
- Create: `src/lib/utils/__tests__/feature-flags.test.ts`

- [ ] **Step 1: Create feature flag utility**

Create `src/lib/utils/feature-flags.ts`:

```typescript
/**
 * Check if Docker management features are enabled.
 * Controlled by VITE_DOCKER_MANAGEMENT_FEATURE_FLAG env var.
 *
 * Note: The `VITE_` prefix is required for client-side access via `import.meta.env`.
 * Server-side code (e.g., worker, server functions) should use
 * `DOCKER_MANAGEMENT_FEATURE_FLAG` (without prefix) via `process.env`.
 */
export function isDockerManagementEnabled(): boolean {
  return import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
```

- [ ] **Step 2: Create test for feature flag utility**

Create `src/lib/utils/__tests__/feature-flags.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('isDockerManagementEnabled', () => {
  const originalEnv = import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    // Restore original value
    if (originalEnv === undefined) {
      delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  it('returns true when flag is "true"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    // Re-import to pick up new env value
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(true);
  });

  it('returns false when flag is undefined', async () => {
    delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(false);
  });

  it('returns false when flag is "false"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(false);
  });
});
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test src/lib/utils/__tests__/feature-flags.test.ts`

- [ ] **Step 4: Commit**

```
feat: add feature flag utility for Docker management
```

### Task 1.3: Add stacks settings keys

**Files:**
- Edit: `src/lib/constants/settings-keys.ts`

- [ ] **Step 1: Add stacks settings keys**

Add a new `stacks` section to `SETTINGS_KEYS` after the `docker` section:

```typescript
  stacks: {
    expandedStacks: 'stacks/expandedStacks',
  },
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add stacks settings keys for expand/collapse state
```

---

## Chunk 2: Stack Types & Server Functions

### Task 2.1: Create stack types

**Files:**
- Create: `src/types/stacks.ts`

- [ ] **Step 1: Create stack types file**

Create `src/types/stacks.ts`:

```typescript
/** Deploy status as defined in the design spec */
export type DeployStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'no_change';

/** Sync status for a stack (derived from comparing current vs last deployed commit) */
export type SyncStatus = 'in-sync' | 'pending' | 'failed' | 'unknown';

/** Deploy mode from manifest */
export type DeployMode = 'auto' | 'manual';

/** Trigger source for a deploy */
export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

/** Summary of a stack as shown in the list view */
export interface StackSummary {
  name: string;
  host: string;
  syncStatus: SyncStatus;
  deployMode: DeployMode;
  lastDeployAt: string | null;
  lastDeployStatus: DeployStatus | null;
  containerCount: number;
  icon: string | null;
}

/** Full stack detail shown in expanded view */
export interface StackDetail {
  name: string;
  host: string;
  syncStatus: SyncStatus;
  deployMode: DeployMode;
  composeContent: string;
  lastDeployCommitSha: string | null;
  currentCommitSha: string;
  variables: string[];
  icon: string | null;
}

/** A single deploy history record */
export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  logs: string | null;
  createdAt: string;
}

/** Request to trigger a deploy from the UI */
export interface UIDeployRequest {
  stack: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
}
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add TypeScript types for stack management
```

### Task 2.2: Create stack server functions (real)

**Files:**
- Create: `src/data/stacks.functions.tsx`

These server functions will be called by the UI. They delegate to the deploy pipeline and git management modules (which are built in separate plans). For now, they define the interface and use dynamic imports for server-only dependencies. They use `createServerFn()` with `.validator()` and `.handler()` chaining, matching the pattern in `src/data/docker.functions.tsx`.

- [ ] **Step 1: Create server functions file**

Create `src/data/stacks.functions.tsx`:

```typescript
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { StackSummary, StackDetail, DeployRecord } from '@/types/stacks';

/**
 * List all stacks from the manifest with their current sync status.
 * Reads the manifest via isomorphic-git, cross-references deploy_history for status.
 */
export const listStacks = createServerFn()
  .handler(async (): Promise<StackSummary[]> => {
    const { getStackSummaries } = await import('@/lib/stacks/stack-service');
    return getStackSummaries();
  });

const getStackDetailSchema = z.object({
  stackName: z.string().min(1),
});

/**
 * Get full detail for a single stack, including compose file content and variables.
 */
export const getStackDetail = createServerFn()
  .inputValidator(getStackDetailSchema)
  .handler(async ({ data }): Promise<StackDetail | null> => {
    const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
    return getStackDetailByName(data.stackName);
  });

const triggerDeploySchema = z.object({
  stack: z.string().min(1),
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown', 'restart']),
});

/**
 * Trigger a deploy, teardown, or restart for a stack.
 */
export const triggerDeploy = createServerFn()
  .inputValidator(triggerDeploySchema)
  .handler(async ({ data }): Promise<{ deployId: number }> => {
    const { triggerStackDeploy } = await import('@/lib/stacks/stack-service');
    return triggerStackDeploy(data);
  });

const getDeployHistorySchema = z.object({
  stackName: z.string().min(1),
  limit: z.number().min(1).max(100).optional().default(20),
});

/**
 * Get deploy history for a stack.
 */
export const getDeployHistory = createServerFn()
  .inputValidator(getDeployHistorySchema)
  .handler(async ({ data }): Promise<DeployRecord[]> => {
    const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
    return getStackDeployHistory(data.stackName, data.limit);
  });

const saveComposeFileSchema = z.object({
  stackName: z.string().min(1),
  content: z.string(),
});

/**
 * Save compose file content (creates a git commit).
 */
export const saveComposeFile = createServerFn()
  .inputValidator(saveComposeFileSchema)
  .handler(async ({ data }): Promise<{ commitSha: string }> => {
    const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
    return saveStackComposeFile(data.stackName, data.content);
  });

const updateStackIconSchema = z.object({
  stackName: z.string().min(1),
  iconSlug: z.string().min(1),
});

/**
 * Update stack icon.
 */
export const updateStackIcon = createServerFn()
  .inputValidator(updateStackIconSchema)
  .handler(async ({ data }): Promise<void> => {
    const { updateStackIconSlug } = await import('@/lib/stacks/stack-service');
    return updateStackIconSlug(data.stackName, data.iconSlug);
  });
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

Note: Typecheck will report errors for the missing `@/lib/stacks/stack-service` module. This is expected -- the stack service is built in the deploy pipeline plan. The dynamic imports ensure these don't break the client bundle at runtime. The `createServerFn()` pattern with `.inputValidator()` and `.handler()` matches existing server functions in `src/data/docker.functions.tsx`.

- [ ] **Step 3: Commit**

```
feat: add stack server functions for UI data access
```

### Task 2.3: Create mock stack server functions

**Files:**
- Create: `src/lib/mock/functions/stacks.functions.tsx`

- [ ] **Step 1: Create mock functions file**

Create `src/lib/mock/functions/stacks.functions.tsx`:

```typescript
import type { StackSummary, StackDetail, DeployRecord, UIDeployRequest } from '@/types/stacks';

const MOCK_STACKS: StackSummary[] = [
  {
    name: 'plex',
    host: 'homeserver',
    syncStatus: 'in-sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 3600_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'plex',
  },
  {
    name: 'traefik',
    host: 'homeserver',
    syncStatus: 'pending',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 86400_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 2,
    icon: 'traefik',
  },
  {
    name: 'pihole',
    host: 'pihole-host',
    syncStatus: 'failed',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 7200_000).toISOString(),
    lastDeployStatus: 'failed',
    containerCount: 1,
    icon: 'pi-hole',
  },
  {
    name: 'homeassistant',
    host: 'homeserver',
    syncStatus: 'in-sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 1800_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'home-assistant',
  },
  {
    name: 'grafana',
    host: 'homeserver',
    syncStatus: 'in-sync',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 43200_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 3,
    icon: 'grafana',
  },
];

const MOCK_COMPOSE = `version: '3.8'
services:
  app:
    image: \${APP_IMAGE:-myapp:latest}
    restart: unless-stopped
    ports:
      - "\${APP_PORT:-8080}:8080"
    environment:
      - DATABASE_URL=\${DATABASE_URL}
      - SECRET_KEY=\${SECRET_KEY}
    volumes:
      - app_data:/data

volumes:
  app_data:
`;

const MOCK_DEPLOY_HISTORY: DeployRecord[] = [
  {
    id: 3,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'a1b2c3d',
    envHash: 'abc123',
    status: 'succeeded',
    trigger: 'ui',
    logs: '$ docker compose up -d --remove-orphans\nContainer plex-app-1  Running\n',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: 2,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'e4f5g6h',
    envHash: 'def456',
    status: 'succeeded',
    trigger: 'git_push',
    logs: '$ docker compose up -d --remove-orphans\nContainer plex-app-1  Recreating\nContainer plex-app-1  Started\n',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
  },
  {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'i7j8k9l',
    envHash: 'ghi789',
    status: 'failed',
    trigger: 'ui',
    logs: '$ docker compose up -d --remove-orphans\nError: image not found: plex:invalid-tag\n',
    createdAt: new Date(Date.now() - 172800_000).toISOString(),
  },
];

export async function listStacks(): Promise<StackSummary[]> {
  return MOCK_STACKS;
}

export async function getStackDetail(opts: {
  data: { stackName: string };
}): Promise<StackDetail | null> {
  const stack = MOCK_STACKS.find((s) => s.name === opts.data.stackName);
  if (!stack) return null;

  return {
    name: stack.name,
    host: stack.host,
    syncStatus: stack.syncStatus,
    deployMode: stack.deployMode,
    composeContent: MOCK_COMPOSE,
    lastDeployCommitSha: 'a1b2c3d',
    currentCommitSha: 'x9y8z7w',
    variables: ['APP_IMAGE', 'APP_PORT', 'DATABASE_URL', 'SECRET_KEY'],
    icon: stack.icon,
  };
}

export async function triggerDeploy(opts: {
  data: UIDeployRequest;
}): Promise<{ deployId: number }> {
  // Simulate a short delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { deployId: MOCK_DEPLOY_HISTORY.length + 1 };
}

export async function getDeployHistory(opts: {
  data: { stackName: string; limit?: number };
}): Promise<DeployRecord[]> {
  const limit = opts.data.limit ?? 20;
  return MOCK_DEPLOY_HISTORY
    .filter((d) => d.stack === opts.data.stackName)
    .slice(0, limit);
}

export async function saveComposeFile(opts: {
  data: { stackName: string; content: string };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { commitSha: 'mock' + Date.now().toString(36) };
}

export async function updateStackIcon(_opts: {
  data: { stackName: string; iconSlug: string };
}): Promise<void> {
  // No-op in demo mode
}
```

- [ ] **Step 2: Register demo alias in vite.config.ts**

In `vite.config.ts`, inside the `if (isDemoMode)` block in `buildAliases()`, add after the existing `settings.functions` alias:

```typescript
    aliases['@/data/stacks.functions'] = fileURLToPath(new URL('./src/lib/mock/functions/stacks.functions.tsx', import.meta.url))
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck`

- [ ] **Step 4: Commit**

```
feat: add mock stack server functions and demo mode alias
```

---

## Chunk 3: Stack List Route & Component

### Task 3.0: Create stacks query key constants

**Files:**
- Create: `src/lib/constants/stacks-keys.ts`

- [ ] **Step 1: Create stacks keys constants file**

Create `src/lib/constants/stacks-keys.ts`:

```typescript
/** Query key for the stacks list. Defined here to avoid circular imports between route and components. */
export const STACKS_QUERY_KEY = ['stacks-list'] as const;
```

- [ ] **Step 2: Commit**

```
feat: add stacks query key constants to avoid circular imports
```

### Task 3.1: Create the stacks route

**Files:**
- Create: `src/routes/docker.stacks.tsx`

- [ ] **Step 1: Create the route file**

Create `src/routes/docker.stacks.tsx`:

```typescript
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import PageHeader from '@/components/PageHeader'
import { isDockerManagementEnabled } from '@/lib/utils/feature-flags'
import { listStacks } from '@/data/stacks.functions'
import StacksTable from '@/components/stacks/StacksTable'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'

export const Route = createFileRoute('/docker/stacks')({
  ssr: false,
  component: StacksPageContent,
})

function StacksPageContent() {
  if (!isDockerManagementEnabled()) {
    return (
      <div className="w-full p-6">
        <PageHeader title="Docker Stacks" />
        <p className="text-sm opacity-70">Docker management is not enabled.</p>
      </div>
    )
  }

  return <StacksPage />
}

function StacksPage() {
  const { data: stacks, isLoading, error } = useQuery({
    queryKey: STACKS_QUERY_KEY,
    queryFn: () => listStacks(),
    refetchInterval: 10_000,
  })

  return (
    <div className="w-full p-6">
      <PageHeader title="Docker Stacks" />
      <StacksTable
        stacks={stacks ?? []}
        isLoading={isLoading}
        error={error}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify route generation**

Run: `bun run typecheck`

The route tree will auto-generate when the dev server runs. The file at `src/routes/docker.stacks.tsx` follows the TanStack Router file-based routing convention for nested routes under `/docker`.

- [ ] **Step 3: Commit**

```
feat: add /docker/stacks route with feature flag gate
```

### Task 3.2: Create StacksTable component

**Files:**
- Create: `src/components/stacks/StacksTable.tsx`

This follows the same pattern as `ContainerTable.tsx` -- div-based grid, Paper wrapper, column headers, virtualizer body.

- [ ] **Step 1: Create StacksTable component**

Create `src/components/stacks/StacksTable.tsx`:

```typescript
import { useRef, useMemo } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Box, CircularProgress, Paper, Typography } from '@mui/material';
import type { StackSummary } from '@/types/stacks';
import StackRow from '@/components/stacks/StackRow';
import { useStackExpansion } from '@/hooks/useStackExpansion';

export const STACKS_GRID = 'grid grid-cols-[minmax(250px,2fr)_minmax(120px,1fr)_minmax(100px,1fr)_minmax(100px,1fr)_minmax(100px,1fr)] min-w-[600px]';

const ROW_HEIGHT_ESTIMATE = 48;
const EXPANDED_ROW_HEIGHT_ESTIMATE = 600;
const OVERSCAN = 5;

interface StacksTableProps {
  stacks: StackSummary[];
  isLoading: boolean;
  error: Error | null;
}

export default function StacksTable({ stacks, isLoading, error }: StacksTableProps) {
  const { isStackExpanded, toggleStackExpanded } = useStackExpansion();

  const sortedStacks = useMemo(
    () => [...stacks].sort((a, b) => a.name.localeCompare(b.name)),
    [stacks],
  );

  const groupHeights = useMemo(
    () => sortedStacks.map((s) => isStackExpanded(s.name) ? EXPANDED_ROW_HEIGHT_ESTIMATE : ROW_HEIGHT_ESTIMATE),
    [sortedStacks, isStackExpanded],
  );

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: sortedStacks.length,
    estimateSize: (index: number) => groupHeights[index],
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => `stack-${sortedStacks[index].name}`,
  });

  const items = virtualizer.getVirtualItems();

  if (error && stacks.length === 0) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
            Error loading stacks: {error.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (isLoading && stacks.length === 0) {
    return (
      <Box className="w-full">
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  if (stacks.length === 0) {
    return (
      <Box className="w-full">
        <Paper variant="outlined" className="rounded-sm p-8 text-center">
          <Typography variant="body1" className="opacity-70">
            No stacks found. Create a stack by adding a docker-compose.yml to the repository.
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box className="w-full">
      <Paper variant="outlined" className="rounded-sm overflow-x-auto">
        <div className="min-w-[600px]">
          {/* Column headers */}
          <div className={`${STACKS_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Stack</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Host</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Status</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Mode</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Last Deploy</div>
          </div>

          {/* Virtualized body */}
          <div ref={listRef}>
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
                willChange: 'transform',
                contain: 'layout style',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translate3d(0, ${(items[0]?.start ?? 0) - virtualizer.options.scrollMargin}px, 0)`,
                }}
              >
                {items.map((virtualRow) => {
                  const stack = sortedStacks[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                    >
                      <StackRow
                        stack={stack}
                        expanded={isStackExpanded(stack.name)}
                        onToggle={() => toggleStackExpanded(stack.name)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </Paper>
    </Box>
  );
}
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add StacksTable component with virtualized list
```

### Task 3.3: Create useStackExpansion hook

**Files:**
- Create: `src/hooks/useStackExpansion.ts`
- Create: `src/hooks/__tests__/useStackExpansion.test.ts`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useStackExpansion.ts`:

```typescript
import { useCallback } from 'react';
import { useSettings } from '@/hooks/useSettings';

/**
 * Hook for managing stack expand/collapse state.
 * Uses the settings atom for persistence, following the same pattern
 * as isHostExpanded/toggleHostExpanded in useSettings.
 */
export function useStackExpansion() {
  const { isStackExpanded: isExpanded, toggleStackExpanded: toggle } = useSettings();

  const isStackExpanded = useCallback(
    (stackName: string) => isExpanded(stackName),
    [isExpanded],
  );

  const toggleStackExpanded = useCallback(
    (stackName: string) => toggle(stackName),
    [toggle],
  );

  return { isStackExpanded, toggleStackExpanded };
}
```

Note: This hook requires adding `isStackExpanded` and `toggleStackExpanded` to the `useSettings` hook. If the settings hook doesn't yet support stacks, add the state management using `SETTINGS_KEYS.stacks.expandedStacks` following the same pattern as `docker.expandedHosts`. This is a JSON-serialized Set of expanded stack names stored in the settings DB.

- [ ] **Step 2: Add stack expansion to useSettings**

Edit the `useSettings` hook (find the file via `grep -r "export function useSettings" src/`) to add:
- `isStackExpanded: (stackName: string) => boolean` -- checks if a stack name is in the expanded set
- `toggleStackExpanded: (stackName: string) => void` -- toggles a stack name in the expanded set

Follow the exact same pattern used for `isHostExpanded`/`toggleHostExpanded`.

- [ ] **Step 3: Create test**

Create `src/hooks/__tests__/useStackExpansion.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

/**
 * Test useStackExpansion by providing mock settings functions via dependency injection.
 * Per CLAUDE.md: Do NOT use mock.module on @/hooks/useSettings -- it pollutes globally
 * across concurrent tests. Instead, refactor useStackExpansion to accept an optional
 * settings override for testing, or test it indirectly through the settings integration.
 *
 * Approach: The hook is a thin wrapper around useSettings, so we test it by verifying
 * the integration with a test-friendly Jotai provider that pre-seeds settings state.
 */

import { Provider } from 'jotai';
import { useStackExpansion } from '../useStackExpansion';

function createTestWrapper() {
  // Create a fresh Jotai store for isolation between tests
  const { createStore } = require('jotai');
  const store = createStore();
  return ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
}

describe('useStackExpansion', () => {
  it('returns false for unexpanded stacks by default', () => {
    const wrapper = createTestWrapper();
    const { result } = renderHook(() => useStackExpansion(), { wrapper });
    expect(result.current.isStackExpanded('plex')).toBe(false);
  });

  it('toggles stack expansion state', () => {
    const wrapper = createTestWrapper();
    const { result } = renderHook(() => useStackExpansion(), { wrapper });
    act(() => {
      result.current.toggleStackExpanded('plex');
    });
    expect(result.current.isStackExpanded('plex')).toBe(true);
    act(() => {
      result.current.toggleStackExpanded('plex');
    });
    expect(result.current.isStackExpanded('plex')).toBe(false);
  });

  it('tracks multiple stacks independently', () => {
    const wrapper = createTestWrapper();
    const { result } = renderHook(() => useStackExpansion(), { wrapper });
    act(() => {
      result.current.toggleStackExpanded('plex');
      result.current.toggleStackExpanded('traefik');
    });
    expect(result.current.isStackExpanded('plex')).toBe(true);
    expect(result.current.isStackExpanded('traefik')).toBe(true);
    expect(result.current.isStackExpanded('grafana')).toBe(false);
  });
});
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun test src/hooks/__tests__/useStackExpansion.test.ts`

- [ ] **Step 5: Commit**

```
feat: add useStackExpansion hook with settings persistence
```

---

## Chunk 4: Stack Row & Status Badges

### Task 4.1: Create SyncStatusBadge component

**Files:**
- Create: `src/components/stacks/SyncStatusBadge.tsx`
- Create: `src/components/stacks/__tests__/SyncStatusBadge.test.tsx`

- [ ] **Step 1: Create SyncStatusBadge component**

Create `src/components/stacks/SyncStatusBadge.tsx`:

```typescript
import { Chip } from '@mui/material';
import { CheckCircle, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import type { SyncStatus } from '@/types/stacks';

const STATUS_CONFIG: Record<SyncStatus, {
  label: string;
  colorVar: string;
  icon: React.ReactNode;
}> = {
  'in-sync': {
    label: 'In Sync',
    colorVar: 'var(--chart-deploy-success)',
    icon: <CheckCircle size={14} />,
  },
  pending: {
    label: 'Pending',
    colorVar: 'var(--chart-deploy-pending)',
    icon: <AlertTriangle size={14} />,
  },
  failed: {
    label: 'Failed',
    colorVar: 'var(--chart-deploy-failed)',
    icon: <XCircle size={14} />,
  },
  unknown: {
    label: 'Unknown',
    colorVar: 'var(--chart-text-muted)',
    icon: <HelpCircle size={14} />,
  },
};

interface SyncStatusBadgeProps {
  status: SyncStatus;
}

export default function SyncStatusBadge({ status }: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<span className="flex items-center" style={{ color: config.colorVar }}>{config.icon}</span>}
      label={config.label}
      className="!border-current"
      style={{ color: config.colorVar }}
    />
  );
}
```

- [ ] **Step 2: Create test**

Create `src/components/stacks/__tests__/SyncStatusBadge.test.tsx`:

```typescript
import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import SyncStatusBadge from '../SyncStatusBadge';

describe('SyncStatusBadge', () => {
  it('renders "In Sync" for in-sync status', () => {
    render(<SyncStatusBadge status="in-sync" />);
    expect(screen.getByText('In Sync')).toBeDefined();
  });

  it('renders "Pending" for pending status', () => {
    render(<SyncStatusBadge status="pending" />);
    expect(screen.getByText('Pending')).toBeDefined();
  });

  it('renders "Failed" for failed status', () => {
    render(<SyncStatusBadge status="failed" />);
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders "Unknown" for unknown status', () => {
    render(<SyncStatusBadge status="unknown" />);
    expect(screen.getByText('Unknown')).toBeDefined();
  });
});
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test src/components/stacks/__tests__/SyncStatusBadge.test.tsx`

- [ ] **Step 4: Commit**

```
feat: add SyncStatusBadge component with deploy status colors
```

### Task 4.2: Create StackRow component

**Files:**
- Create: `src/components/stacks/StackRow.tsx`
- Create: `src/components/stacks/__tests__/StackRow.test.tsx`

- [ ] **Step 1: Create StackRow component**

Create `src/components/stacks/StackRow.tsx`:

```typescript
import { useState } from 'react';
import { Chip, Collapse } from '@mui/material';
import { ChevronRight, Layers } from 'lucide-react';
import type { StackSummary } from '@/types/stacks';
import { STACKS_GRID } from '@/components/stacks/StacksTable';
import SyncStatusBadge from '@/components/stacks/SyncStatusBadge';
import StackDetail from '@/components/stacks/StackDetail';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';

interface StackRowProps {
  stack: StackSummary;
  expanded: boolean;
  onToggle: () => void;
}

function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return 'Never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Per CLAUDE.md gotcha #5: Do not use React.memo on components receiving streaming/frequently-updated data.
// Incorrect memoization can freeze streaming updates.
export default function StackRow({ stack, expanded, onToggle }: StackRowProps) {
  const [iconError, setIconError] = useState(false);
  const iconUrl = stack.icon ? getIconUrl(stack.icon, '') : null;

  return (
    <div>
      <div
        onClick={onToggle}
        className={`group ${STACKS_GRID} items-center cursor-pointer border-t border-neutral-200 dark:border-neutral-700 transition-[background-color,box-shadow] duration-150 ${
          expanded
            ? 'bg-[var(--mui-palette-action-hover)]'
            : 'hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]'
        }`}
      >
        {/* Stack name + icon */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-2">
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />
            {iconUrl && !iconError ? (
              <img
                src={iconUrl}
                alt=""
                className="w-5 h-5 flex-shrink-0"
                onError={() => setIconError(true)}
              />
            ) : (
              <Layers size={18} className="flex-shrink-0 opacity-60" />
            )}
            <span className="font-medium truncate">{stack.name}</span>
            <Chip
              size="small"
              variant="filled"
              label={`${stack.containerCount} container${stack.containerCount !== 1 ? 's' : ''}`}
              className="!text-xs"
            />
          </div>
        </div>

        {/* Host */}
        <div className="px-3 py-2">
          <span className="text-sm truncate">{stack.host}</span>
        </div>

        {/* Sync status */}
        <div className="px-3 py-2">
          <SyncStatusBadge status={stack.syncStatus} />
        </div>

        {/* Deploy mode */}
        <div className="px-3 py-2">
          <Chip
            size="small"
            variant="outlined"
            label={stack.deployMode === 'auto' ? 'Auto' : 'Manual'}
            className={stack.deployMode === 'auto'
              ? '!text-[var(--chart-deploy-success)] !border-[var(--chart-deploy-success)]'
              : '!text-[var(--chart-text-muted)] !border-[var(--chart-text-muted)]'
            }
          />
        </div>

        {/* Last deploy */}
        <div className="px-3 py-2">
          <span className="text-sm opacity-70">{formatRelativeTime(stack.lastDeployAt)}</span>
        </div>
      </div>

      <Collapse in={expanded} unmountOnExit>
        <StackDetail stackName={stack.name} />
      </Collapse>
    </div>
  );
}
```

- [ ] **Step 2: Create test**

Create `src/components/stacks/__tests__/StackRow.test.tsx`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackSummary } from '@/types/stacks';

// Mock StackDetail to avoid deep dependency tree
mock.module('@/components/stacks/StackDetail', () => ({
  default: ({ stackName }: { stackName: string }) => <div data-testid="stack-detail">{stackName}</div>,
}));

// Mock icon resolver
mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => '/icons/test.svg',
  FALLBACK_ICON_URL: '/icons/fallback.svg',
}));

import StackRow from '../StackRow';

const mockStack: StackSummary = {
  name: 'plex',
  host: 'homeserver',
  syncStatus: 'in-sync',
  deployMode: 'auto',
  lastDeployAt: new Date(Date.now() - 3600_000).toISOString(),
  lastDeployStatus: 'succeeded',
  containerCount: 1,
  icon: 'plex',
};

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('StackRow', () => {
  it('renders stack name and host', () => {
    renderWithQuery(<StackRow stack={mockStack} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('plex')).toBeDefined();
    expect(screen.getByText('homeserver')).toBeDefined();
  });

  it('renders sync status badge', () => {
    renderWithQuery(<StackRow stack={mockStack} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('In Sync')).toBeDefined();
  });

  it('renders deploy mode chip', () => {
    renderWithQuery(<StackRow stack={mockStack} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('Auto')).toBeDefined();
  });

  it('renders container count', () => {
    renderWithQuery(<StackRow stack={mockStack} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('1 container')).toBeDefined();
  });

  it('calls onToggle when clicked', () => {
    const toggleFn = mock(() => {});
    renderWithQuery(<StackRow stack={mockStack} expanded={false} onToggle={toggleFn} />);
    fireEvent.click(screen.getByText('plex'));
    expect(toggleFn).toHaveBeenCalled();
  });

  it('pluralizes container count', () => {
    const multiStack = { ...mockStack, containerCount: 3 };
    renderWithQuery(<StackRow stack={multiStack} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('3 containers')).toBeDefined();
  });
});
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test src/components/stacks/__tests__/StackRow.test.tsx`

- [ ] **Step 4: Commit**

```
feat: add StackRow component with status badges and expand/collapse
```

---

## Chunk 5: Stack Detail Panel -- Deploy Controls & History

### Task 5.1: Create StackDetail component

**Files:**
- Create: `src/components/stacks/StackDetail.tsx`

This is the expanded panel for a stack row. Contains deploy controls, deploy history, and a link to open the editor.

- [ ] **Step 1: Create StackDetail component**

Create `src/components/stacks/StackDetail.tsx`:

```typescript
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Paper, Typography, CircularProgress } from '@mui/material';
import { Play, Square, RotateCcw, FileEdit, Clock } from 'lucide-react';
import { getStackDetail, triggerDeploy, getDeployHistory } from '@/data/stacks.functions';
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys';
import type { DeployRecord, UIDeployRequest } from '@/types/stacks';
import DeployHistoryList from '@/components/stacks/DeployHistoryList';
import SyncStatusBadge from '@/components/stacks/SyncStatusBadge';
import ComposeEditorLoader from '@/components/stacks/ComposeEditorLoader';

interface StackDetailProps {
  stackName: string;
}

export default function StackDetail({ stackName }: StackDetailProps) {
  const queryClient = useQueryClient();
  const [showEditor, setShowEditor] = useState(false);
  const [teardownConfirmOpen, setTeardownConfirmOpen] = useState(false);

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
    staleTime: 10_000,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['deploy-history', stackName],
    queryFn: () => getDeployHistory({ data: { stackName, limit: 10 } }),
    staleTime: 10_000,
  });

  const deployMutation = useMutation({
    mutationFn: (request: UIDeployRequest) => triggerDeploy({ data: request }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] });
      void queryClient.invalidateQueries({ queryKey: ['deploy-history', stackName] });
    },
  });

  const handleAction = (action: UIDeployRequest['action']) => {
    if (!detail) return;
    deployMutation.mutate({
      stack: stackName,
      host: detail.host,
      action,
    });
  };

  if (detailLoading) {
    return (
      <div className="p-4 flex justify-center">
        <CircularProgress size={24} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-4">
        <Typography color="error">Stack not found</Typography>
      </div>
    );
  }

  return (
    <div className="p-4 border-t border-neutral-200 dark:border-neutral-700 bg-[var(--mui-palette-background-level1)]">
      {/* Top bar: status + deploy controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <SyncStatusBadge status={detail.syncStatus} />

        <div className="flex-1" />

        <Button
          size="small"
          variant="contained"
          startIcon={deployMutation.isPending ? <CircularProgress size={14} /> : <Play size={14} />}
          onClick={() => handleAction('deploy')}
          disabled={deployMutation.isPending}
          className="!bg-[var(--chart-deploy-success)] hover:!bg-[var(--chart-deploy-success)]/80 !text-white !normal-case"
        >
          Deploy
        </Button>

        <Button
          size="small"
          variant="outlined"
          startIcon={<RotateCcw size={14} />}
          onClick={() => handleAction('restart')}
          disabled={deployMutation.isPending}
          className="!normal-case"
        >
          Restart
        </Button>

        <Button
          size="small"
          variant="outlined"
          color="error"
          startIcon={<Square size={14} />}
          onClick={() => setTeardownConfirmOpen(true)}
          disabled={deployMutation.isPending}
          className="!normal-case"
        >
          Teardown
        </Button>

        <Button
          size="small"
          variant="outlined"
          startIcon={<FileEdit size={14} />}
          onClick={() => setShowEditor(!showEditor)}
          className="!normal-case"
        >
          {showEditor ? 'Close Editor' : 'Edit Compose'}
        </Button>
      </div>

      {/* Compose editor (lazy loaded) */}
      {showEditor && (
        <ComposeEditorLoader
          stackName={stackName}
          content={detail.composeContent}
          variables={detail.variables}
        />
      )}

      {/* Commit info */}
      <Paper elevation={0} className="p-3 mb-4 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
        <div className="flex items-center gap-4 text-sm">
          <span className="opacity-70">Current commit:</span>
          <code className="font-mono text-xs bg-black/10 dark:bg-white/10 px-2 py-0.5 rounded">
            {detail.currentCommitSha.substring(0, 7)}
          </code>
          {detail.lastDeployCommitSha && (
            <>
              <span className="opacity-70">Last deployed:</span>
              <code className="font-mono text-xs bg-black/10 dark:bg-white/10 px-2 py-0.5 rounded">
                {detail.lastDeployCommitSha.substring(0, 7)}
              </code>
            </>
          )}
        </div>
      </Paper>

      {/* Deploy history */}
      <div className="flex items-center gap-2 mb-2">
        <Clock size={16} className="opacity-60" />
        <Typography variant="subtitle2">Deploy History</Typography>
      </div>
      <DeployHistoryList
        records={history ?? []}
        isLoading={historyLoading}
      />

      {/* Teardown confirmation dialog */}
      <Dialog
        open={teardownConfirmOpen}
        onClose={() => setTeardownConfirmOpen(false)}
      >
        <DialogTitle>Confirm Teardown</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to tear down the <strong>{stackName}</strong> stack?
            This will stop and remove all containers in the stack.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTeardownConfirmOpen(false)} className="!normal-case">
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              setTeardownConfirmOpen(false);
              handleAction('teardown');
            }}
            className="!normal-case"
          >
            Teardown
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add StackDetail component with deploy controls
```

### Task 5.2: Create DeployHistoryList component

**Files:**
- Create: `src/components/stacks/DeployHistoryList.tsx`
- Create: `src/components/stacks/__tests__/DeployHistoryList.test.tsx`

- [ ] **Step 1: Create DeployHistoryList component**

Create `src/components/stacks/DeployHistoryList.tsx`:

```typescript
import { useState } from 'react';
import { Chip, Collapse, Paper, Skeleton, Typography } from '@mui/material';
import { ChevronRight, GitCommit } from 'lucide-react';
import type { DeployRecord, DeployStatus, DeployTrigger } from '@/types/stacks';

const STATUS_COLOR: Record<DeployStatus, string> = {
  succeeded: 'var(--chart-deploy-success)',
  failed: 'var(--chart-deploy-failed)',
  pending: 'var(--chart-deploy-pending)',
  in_progress: 'var(--chart-deploy-in-progress)',
  no_change: 'var(--chart-text-muted)',
};

const STATUS_LABEL: Record<DeployStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  pending: 'Pending',
  in_progress: 'In Progress',
  no_change: 'No Change',
};

const TRIGGER_LABEL: Record<DeployTrigger, string> = {
  git_push: 'Git Push',
  ui: 'UI',
  manual_rollback: 'Rollback',
};

interface DeployHistoryListProps {
  records: DeployRecord[];
  isLoading: boolean;
}

export default function DeployHistoryList({ records, isLoading }: DeployHistoryListProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} variant="rounded" height={40} className="!bg-[var(--mui-palette-action-hover)]" />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <Typography variant="body2" className="opacity-50 py-2">
        No deploy history.
      </Typography>
    );
  }

  return (
    <div className="space-y-1">
      {records.map((record) => (
        <DeployHistoryRow key={record.id} record={record} />
      ))}
    </div>
  );
}

function DeployHistoryRow({ record }: { record: DeployRecord }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = STATUS_COLOR[record.status];
  const timestamp = new Date(record.createdAt);

  return (
    <Paper
      elevation={0}
      className="!bg-[var(--mui-palette-background-chartBg)] rounded-sm overflow-hidden"
    >
      <div
        onClick={() => record.logs && setExpanded(!expanded)}
        className={`flex items-center gap-3 px-3 py-2 text-sm ${record.logs ? 'cursor-pointer hover:bg-blue-500/5' : ''}`}
      >
        {record.logs && (
          <ChevronRight
            size={14}
            className={`transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        {!record.logs && <div className="w-3.5" />}

        <GitCommit size={14} className="opacity-60 flex-shrink-0" />
        <code className="font-mono text-xs">{record.commitSha.substring(0, 7)}</code>

        <Chip
          size="small"
          label={STATUS_LABEL[record.status]}
          className="!text-xs !h-5"
          style={{ color: statusColor, borderColor: statusColor }}
          variant="outlined"
        />

        <Chip
          size="small"
          label={TRIGGER_LABEL[record.trigger]}
          className="!text-xs !h-5"
          variant="filled"
        />

        <span className="ml-auto opacity-50 text-xs whitespace-nowrap">
          {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString()}
        </span>
      </div>

      {record.logs && (
        <Collapse in={expanded} unmountOnExit>
          <pre className="px-4 py-2 text-xs font-mono whitespace-pre-wrap opacity-80 border-t border-neutral-200 dark:border-neutral-700 max-h-[200px] overflow-y-auto">
            {record.logs}
          </pre>
        </Collapse>
      )}
    </Paper>
  );
}
```

- [ ] **Step 2: Create test**

Create `src/components/stacks/__tests__/DeployHistoryList.test.tsx`:

```typescript
import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DeployRecord } from '@/types/stacks';
import DeployHistoryList from '../DeployHistoryList';

const mockRecords: DeployRecord[] = [
  {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'a1b2c3d4e5f6',
    envHash: 'abc123',
    status: 'succeeded',
    trigger: 'ui',
    logs: 'Deploy output here',
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'f6e5d4c3b2a1',
    envHash: 'def456',
    status: 'failed',
    trigger: 'git_push',
    logs: 'Error: something went wrong',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
  },
];

describe('DeployHistoryList', () => {
  it('renders loading skeletons when isLoading is true', () => {
    const { container } = render(<DeployHistoryList records={[]} isLoading={true} />);
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBe(3);
  });

  it('renders empty message when no records', () => {
    render(<DeployHistoryList records={[]} isLoading={false} />);
    expect(screen.getByText('No deploy history.')).toBeDefined();
  });

  it('renders deploy records with commit sha', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('a1b2c3d')).toBeDefined();
    expect(screen.getByText('f6e5d4c')).toBeDefined();
  });

  it('renders status badges', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('Succeeded')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders trigger labels', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('UI')).toBeDefined();
    expect(screen.getByText('Git Push')).toBeDefined();
  });

  it('expands log output on click', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    fireEvent.click(screen.getByText('a1b2c3d'));
    expect(screen.getByText('Deploy output here')).toBeDefined();
  });
});
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test src/components/stacks/__tests__/DeployHistoryList.test.tsx`

- [ ] **Step 4: Commit**

```
feat: add DeployHistoryList component with expandable logs
```

---

## Chunk 6: Monaco Compose Editor with Variable Detection

### Task 6.1: Create ComposeEditor component (dynamically imported)

**Files:**
- Create: `src/components/stacks/ComposeEditor.tsx`
- Create: `src/components/stacks/ComposeEditorLoader.tsx`
- Create: `src/components/stacks/VariablesPanel.tsx`

Monaco must be dynamically imported to avoid bundle bloat. Use `React.lazy` for the editor component, wrapped in a `Suspense` boundary.

- [ ] **Step 1: Install Monaco dependencies**

Run: `bun add @monaco-editor/react monaco-yaml`

Note: `@monaco-editor/react` provides a React wrapper around Monaco with automatic lazy loading. It handles the web worker setup internally. `monaco-yaml` adds YAML language features including Docker Compose schema validation.

- [ ] **Step 2: Create VariablesPanel component**

Create `src/components/stacks/VariablesPanel.tsx`:

```typescript
import { Paper, Typography, TextField, Chip } from '@mui/material';
import { Key } from 'lucide-react';

interface VariablesPanelProps {
  variables: string[];
}

/**
 * Side panel showing `${VAR}` references detected in a compose file.
 * Displays variable names. When OpenBao is enabled (separate plan),
 * this will include secret value inputs.
 */
export default function VariablesPanel({ variables }: VariablesPanelProps) {
  if (variables.length === 0) {
    return (
      <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
        <Typography variant="body2" className="opacity-50">
          No variables detected.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
      <div className="flex items-center gap-2 mb-3">
        <Key size={16} className="opacity-60" />
        <Typography variant="subtitle2">Variables</Typography>
        <Chip size="small" label={variables.length} className="!text-xs !h-5" />
      </div>
      <div className="space-y-2">
        {variables.map((varName) => (
          <div key={varName} className="flex items-center gap-2">
            <code className="text-xs font-mono min-w-[120px] opacity-80">${'{'}${varName}{'}'}</code>
            <TextField
              size="small"
              placeholder="Value (managed by OpenBao)"
              disabled
              fullWidth
              className="!text-xs"
              slotProps={{
                input: { className: '!text-xs' },
              }}
            />
          </div>
        ))}
      </div>
      <Typography variant="caption" className="!mt-2 block opacity-50">
        Variable values are managed via OpenBao (when configured).
      </Typography>
    </Paper>
  );
}
```

- [ ] **Step 3: Create ComposeEditor component**

Create `src/components/stacks/ComposeEditor.tsx`:

```typescript
import { useCallback, useRef, useState } from 'react';
import { Button, Paper, Typography, CircularProgress } from '@mui/material';
import { Save } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { saveComposeFile } from '@/data/stacks.functions';
import VariablesPanel from '@/components/stacks/VariablesPanel';

interface ComposeEditorProps {
  stackName: string;
  content: string;
  variables: string[];
}

/** Parse ${VAR} and ${VAR:-default} patterns from compose content */
function parseVariables(content: string): string[] {
  const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-[^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort();
}

export default function ComposeEditor({ stackName, content, variables: initialVariables }: ComposeEditorProps) {
  const [editorContent, setEditorContent] = useState(content);
  const [detectedVars, setDetectedVars] = useState<string[]>(initialVariables);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const queryClient = useQueryClient();

  const isDirty = editorContent !== content;

  const saveMutation = useMutation({
    mutationFn: () => saveComposeFile({ data: { stackName, content: editorContent } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] });
    },
  });

  const handleEditorMount = useCallback((editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
    editorRef.current = editor;

    // Configure monaco-yaml for Docker Compose schema validation
    import('monaco-yaml').then(({ configureMonacoYaml }) => {
      configureMonacoYaml(monaco, {
        enableSchemaRequest: true,
        schemas: [
          {
            uri: 'https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json',
            fileMatch: ['*'],
          },
        ],
      });
    });
  }, []);

  const handleChange = useCallback((value: string | undefined) => {
    const newContent = value ?? '';
    setEditorContent(newContent);
    setDetectedVars(parseVariables(newContent));
  }, []);

  const isDark = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-color-scheme') === 'dark';

  return (
    <Paper elevation={0} className="mb-4 !bg-[var(--mui-palette-background-chartBg)] rounded-sm overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
        <Typography variant="subtitle2" className="flex-1">
          docker-compose.yml
        </Typography>
        {isDirty && (
          <Typography variant="caption" className="opacity-60">
            Unsaved changes
          </Typography>
        )}
        <Button
          size="small"
          variant="contained"
          startIcon={saveMutation.isPending ? <CircularProgress size={14} /> : <Save size={14} />}
          onClick={() => saveMutation.mutate()}
          disabled={!isDirty || saveMutation.isPending}
          className="!normal-case"
        >
          Save &amp; Commit
        </Button>
      </div>

      {/* Editor + variables panel */}
      <div className="flex min-h-[400px]">
        <div className="flex-1 min-w-0">
          <Editor
            height="400px"
            language="yaml"
            theme={isDark ? 'vs-dark' : 'light'}
            value={editorContent}
            onChange={handleChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
              renderLineHighlight: 'line',
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <CircularProgress size={24} />
              </div>
            }
          />
        </div>

        {/* Variables side panel */}
        <div className="w-[280px] flex-shrink-0 border-l border-neutral-200 dark:border-neutral-700 p-3 overflow-y-auto">
          <VariablesPanel variables={detectedVars} />
        </div>
      </div>
    </Paper>
  );
}
```

- [ ] **Step 4: Create ComposeEditorLoader (lazy wrapper)**

Create `src/components/stacks/ComposeEditorLoader.tsx`:

```typescript
import { lazy, Suspense } from 'react';
import { CircularProgress, Paper, Typography } from '@mui/material';

const ComposeEditor = lazy(() => import('@/components/stacks/ComposeEditor'));

interface ComposeEditorLoaderProps {
  stackName: string;
  content: string;
  variables: string[];
}

export default function ComposeEditorLoader(props: ComposeEditorLoaderProps) {
  return (
    <Suspense
      fallback={
        <Paper elevation={0} className="p-8 mb-4 !bg-[var(--mui-palette-background-chartBg)] rounded-sm flex items-center justify-center gap-3">
          <CircularProgress size={20} />
          <Typography variant="body2" className="opacity-60">
            Loading editor...
          </Typography>
        </Paper>
      }
    >
      <ComposeEditor {...props} />
    </Suspense>
  );
}
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck`

- [ ] **Step 6: Commit**

```
feat: add Monaco compose editor with variable detection and lazy loading
```

### Task 6.2: Create ComposeEditor tests

**Files:**
- Create: `src/components/stacks/__tests__/ComposeEditor.test.tsx`
- Create: `src/components/stacks/__tests__/VariablesPanel.test.tsx`

- [ ] **Step 1: Create VariablesPanel test**

Create `src/components/stacks/__tests__/VariablesPanel.test.tsx`:

```typescript
import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import VariablesPanel from '../VariablesPanel';

describe('VariablesPanel', () => {
  it('renders empty state when no variables', () => {
    render(<VariablesPanel variables={[]} />);
    expect(screen.getByText('No variables detected.')).toBeDefined();
  });

  it('renders variable names with template syntax', () => {
    render(<VariablesPanel variables={['DATABASE_URL', 'SECRET_KEY']} />);
    expect(screen.getByText(/DATABASE_URL/)).toBeDefined();
    expect(screen.getByText(/SECRET_KEY/)).toBeDefined();
  });

  it('renders variable count badge', () => {
    render(<VariablesPanel variables={['A', 'B', 'C']} />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders disabled inputs with OpenBao placeholder', () => {
    render(<VariablesPanel variables={['MY_VAR']} />);
    const input = screen.getByPlaceholderText('Value (managed by OpenBao)');
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Create parseVariables unit test**

Create `src/components/stacks/__tests__/ComposeEditor.test.tsx`:

```typescript
import { describe, it, expect } from 'bun:test';

describe('parseVariables (compose variable detection)', () => {
  // Regex-based variable detection (same logic as ComposeEditor)
  function parseVariables(content: string): string[] {
    const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-[^}]*)?\}/g;
    const vars = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      vars.add(match[1]);
    }
    return Array.from(vars).sort();
  }

  it('detects simple variable references', () => {
    const content = 'image: ${MY_IMAGE}\nport: ${MY_PORT}';
    expect(parseVariables(content)).toEqual(['MY_IMAGE', 'MY_PORT']);
  });

  it('detects variables with defaults', () => {
    const content = 'image: ${APP_IMAGE:-myapp:latest}';
    expect(parseVariables(content)).toEqual(['APP_IMAGE']);
  });

  it('deduplicates variables', () => {
    const content = '${VAR}\n${VAR}\n${VAR}';
    expect(parseVariables(content)).toEqual(['VAR']);
  });

  it('returns empty array for no variables', () => {
    expect(parseVariables('image: nginx:latest')).toEqual([]);
  });

  it('sorts variables alphabetically', () => {
    const content = '${ZEBRA}\n${ALPHA}\n${MIDDLE}';
    expect(parseVariables(content)).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
  });

  it('matches lowercase and mixed-case variable names', () => {
    const content = '${lowercase}\n${Mixed_Case}\n${UPPER}';
    expect(parseVariables(content)).toEqual(['Mixed_Case', 'UPPER', 'lowercase']);
  });
});
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun test src/components/stacks/__tests__/`

- [ ] **Step 4: Commit**

```
test: add tests for VariablesPanel and compose variable detection
```

---

## Chunk 7: Navigation Integration

### Task 7.1: Add Stacks link to Docker monitoring page

**Files:**
- Edit: `src/routes/docker.tsx`

Add a conditional link to `/docker/stacks` when the feature flag is enabled, shown in the PageHeader area.

- [ ] **Step 1: Add Stacks link to Docker page**

In `src/routes/docker.tsx`, add the feature flag import and a link button:

1. Add imports:
```typescript
import { Link } from '@tanstack/react-router'
import { Button } from '@mui/material'
import { Layers } from 'lucide-react'
import { isDockerManagementEnabled } from '@/lib/utils/feature-flags'
```

2. In `DockerPageContent`, update the `<PageHeader>` to include a children slot:
```typescript
      <PageHeader title="Docker Containers Dashboard">
        {isDockerManagementEnabled() && (
          <Button
            component={Link}
            to="/docker/stacks"
            size="small"
            variant="outlined"
            startIcon={<Layers size={16} />}
            className="!normal-case !mt-2"
          >
            Manage Stacks
          </Button>
        )}
      </PageHeader>
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add Stacks navigation link to Docker monitoring page
```

### Task 7.2: Add stack badge to ContainerRow (enrichment)

**Files:**
- Edit: `src/components/docker/ContainerRow.tsx`

When the feature flag is on, show a small "Stack" badge on containers that belong to a managed stack. This requires the stack association data from the stacks list query.

Note: This is a light-touch enhancement. The full stack-to-container association requires data from the deploy pipeline (mapping `com.docker.compose.project` labels to stack names). For now, add the UI hook point as a prop.

- [ ] **Step 1: Add optional stackName prop to ContainerRow**

In `src/components/docker/ContainerRow.tsx`:

1. Add to `ContainerRowProps`:
```typescript
  stackName?: string | null;
```

2. After the container name `<span>` and the history button, add:
```typescript
            {stackName && (
              <Chip
                size="small"
                variant="outlined"
                label={stackName}
                component={Link}
                to="/docker/stacks"
                clickable
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                className="!text-xs !h-5 !cursor-pointer"
                icon={<Layers size={12} />}
              />
            )}
```

3. Add imports:
```typescript
import { Layers } from 'lucide-react';
import { Link } from '@tanstack/react-router';
```

Note: The `stackName` prop will be passed from `ContainerTable` once the stack-container mapping is available from the deploy pipeline. For now, it defaults to `undefined` (no badge shown).

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```
feat: add stack badge prop to ContainerRow for stack association
```

---

## Chunk 8: Final Integration & Tests

### Task 8.1: Create StacksTable integration test

**Files:**
- Create: `src/components/stacks/__tests__/StacksTable.test.tsx`

- [ ] **Step 1: Create integration test**

Create `src/components/stacks/__tests__/StacksTable.test.tsx`:

```typescript
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackSummary } from '@/types/stacks';

/**
 * Per CLAUDE.md: Do NOT use mock.module on framework modules like @tanstack/react-virtual.
 * It pollutes globally across concurrent tests.
 *
 * Instead, test the non-virtualized states (loading, error, empty) directly,
 * and for populated states, set up a scrollable container so the real virtualizer works.
 * The virtualizer needs a window with scroll dimensions, which Happy-DOM provides.
 */

// Narrow-scope mocks for leaf components only (not framework modules)
mock.module('@/components/stacks/StackDetail', () => ({
  default: ({ stackName }: { stackName: string }) => <div data-testid="stack-detail">{stackName}</div>,
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => '/icons/test.svg',
  FALLBACK_ICON_URL: '/icons/fallback.svg',
}));

import { Provider } from 'jotai';
import StacksTable from '../StacksTable';

const mockStacks: StackSummary[] = [
  {
    name: 'plex',
    host: 'homeserver',
    syncStatus: 'in-sync',
    deployMode: 'auto',
    lastDeployAt: new Date().toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'plex',
  },
  {
    name: 'traefik',
    host: 'homeserver',
    syncStatus: 'pending',
    deployMode: 'manual',
    lastDeployAt: null,
    lastDeployStatus: null,
    containerCount: 2,
    icon: null,
  },
];

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { createStore } = require('jotai');
  const store = createStore();
  return render(
    <Provider store={store}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </Provider>,
  );
}

describe('StacksTable', () => {
  it('renders loading state', () => {
    const { container } = renderWithProviders(
      <StacksTable stacks={[]} isLoading={true} error={null} />,
    );
    expect(container.querySelector('.MuiCircularProgress-root')).toBeDefined();
  });

  it('renders error state', () => {
    renderWithProviders(
      <StacksTable stacks={[]} isLoading={false} error={new Error('Connection failed')} />,
    );
    expect(screen.getByText(/Connection failed/)).toBeDefined();
  });

  it('renders empty state', () => {
    renderWithProviders(
      <StacksTable stacks={[]} isLoading={false} error={null} />,
    );
    expect(screen.getByText(/No stacks found/)).toBeDefined();
  });

  it('renders column headers when stacks provided', () => {
    renderWithProviders(
      <StacksTable stacks={mockStacks} isLoading={false} error={null} />,
    );
    expect(screen.getByText('Stack')).toBeDefined();
    expect(screen.getByText('Host')).toBeDefined();
    expect(screen.getByText('Status')).toBeDefined();
    expect(screen.getByText('Mode')).toBeDefined();
    expect(screen.getByText('Last Deploy')).toBeDefined();
  });
});
```

Note: The virtualized row rendering tests (checking that rows appear and are sorted) are omitted here because testing `useWindowVirtualizer` requires a real scroll context. These are better covered in an E2E test or by testing `StackRow` in isolation (see Task 4.2 tests). Do NOT mock `@tanstack/react-virtual` globally -- per CLAUDE.md gotcha, `mock.module` on broadly-used/framework modules pollutes across concurrent tests.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun test src/components/stacks/__tests__/`

- [ ] **Step 3: Commit**

```
test: add StacksTable integration test
```

### Task 8.2: Full verification pass

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`

Fix any remaining type errors. Common issues:
- Missing imports for `Link` from `@tanstack/react-router`
- `getCssVar` import path may need verification
- `STACKS_QUERY_KEY` is in `src/lib/constants/stacks-keys.ts` -- import from there, never from the route file

- [ ] **Step 2: Run full test suite**

Run: `bun test`

Ensure all new tests pass and existing tests are not broken.

- [ ] **Step 3: Verify route generation**

Start the dev server briefly to confirm `routeTree.gen.ts` includes the new `/docker/stacks` route:

Run: `timeout 10 bun dev 2>&1 | head -30`

Check that no errors appear related to the new route.

- [ ] **Step 4: Commit any fixes**

```
fix: resolve typecheck and test issues for stacks page
```

---

## Summary of Files

### New Files Created
| File | Purpose |
|------|---------|
| `src/lib/constants/stacks-keys.ts` | Stacks query key constants (avoids circular imports) |
| `src/lib/utils/feature-flags.ts` | Feature flag utility |
| `src/lib/utils/__tests__/feature-flags.test.ts` | Feature flag tests |
| `src/types/stacks.ts` | Stack type definitions |
| `src/data/stacks.functions.tsx` | Real server functions using `createServerFn()` (delegates to stack-service) |
| `src/lib/mock/functions/stacks.functions.tsx` | Mock server functions for demo mode |
| `src/routes/docker.stacks.tsx` | Stacks page route |
| `src/components/stacks/StacksTable.tsx` | Virtualized stack list |
| `src/components/stacks/StackRow.tsx` | Individual stack row with badges |
| `src/components/stacks/StackDetail.tsx` | Expanded stack detail panel |
| `src/components/stacks/SyncStatusBadge.tsx` | Sync status badge component |
| `src/components/stacks/DeployHistoryList.tsx` | Deploy history with expandable logs |
| `src/components/stacks/ComposeEditor.tsx` | Monaco editor for compose files |
| `src/components/stacks/ComposeEditorLoader.tsx` | Lazy loading wrapper for Monaco |
| `src/components/stacks/VariablesPanel.tsx` | Variable detection side panel |
| `src/hooks/useStackExpansion.ts` | Stack expand/collapse hook |
| `src/hooks/__tests__/useStackExpansion.test.ts` | Hook test |
| `src/components/stacks/__tests__/SyncStatusBadge.test.tsx` | Badge test |
| `src/components/stacks/__tests__/StackRow.test.tsx` | Row test |
| `src/components/stacks/__tests__/DeployHistoryList.test.tsx` | History test |
| `src/components/stacks/__tests__/ComposeEditor.test.tsx` | Editor/variable detection test |
| `src/components/stacks/__tests__/VariablesPanel.test.tsx` | Variables panel test |
| `src/components/stacks/__tests__/StacksTable.test.tsx` | Integration test |

### Existing Files Modified
| File | Change |
|------|--------|
| `src/App.css` | Deploy status CSS variables |
| `src/lib/constants/settings-keys.ts` | Stack settings keys |
| `vite.config.ts` | Demo mode alias for stacks.functions |
| `src/routes/docker.tsx` | "Manage Stacks" link (feature-gated) |
| `src/components/docker/ContainerRow.tsx` | Optional `stackName` prop for badge |
| `src/hooks/useSettings.ts` | Stack expansion state management |

### Dependencies Added
| Package | Reason |
|---------|--------|
| `@monaco-editor/react` | Monaco editor React wrapper (lazy loaded) |
| `monaco-yaml` | YAML language features + Docker Compose schema validation for Monaco |
