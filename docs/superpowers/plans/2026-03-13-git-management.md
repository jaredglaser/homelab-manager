# Git Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Git management subsystem for Docker stack management. This includes bare git repo operations via isomorphic-git, a Git HTTP smart protocol server endpoint (upload-pack / receive-pack), post-receive change detection triggering the deploy pipeline, manifest parsing with validation, and in-app file reading/writing.

**Architecture:** Bare git repos stored in a configurable Docker volume directory (`GIT_REPOS_DIR`). The homelab-manager server exposes `/api/git/*` routes for Git HTTP smart protocol (clone/push) by shelling out to `git upload-pack` and `git receive-pack` via `Bun.spawn()`. All repo read/write operations (init, commit, tree listing, file read/write, log, diff) use isomorphic-git with the Node.js `fs` module. Post-receive logic diffs the pushed commits, identifies changed stack directories, parses the manifest, and hands off deploy requests. The entire subsystem is feature-flagged behind `DOCKER_MANAGEMENT_FEATURE_FLAG`.

**Tech Stack:** isomorphic-git (repo operations), js-yaml (manifest parsing), `git` CLI (smart HTTP protocol via Bun.spawn), zod (manifest validation), TanStack Router server routes (HTTP endpoints)

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 2: Git Management)

**New Dependencies:** `isomorphic-git`, `js-yaml`, `@types/js-yaml`

---

## Chunk 1: Dependencies & Git Config Module

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install isomorphic-git and js-yaml**

Run:
```bash
bun add isomorphic-git js-yaml
bun add -d @types/js-yaml
```

Expected: `package.json` updated with `isomorphic-git`, `js-yaml` in dependencies, `@types/js-yaml` in devDependencies.

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "feat(git): add isomorphic-git and js-yaml dependencies"
```

---

### Task 2: Git config module

**Files:**
- Create: `src/lib/config/git-config.ts`
- Create: `src/lib/config/__tests__/git-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/config/__tests__/git-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadGitConfig } from '../git-config';

describe('loadGitConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
  });

  afterEach(() => {
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    Object.assign(process.env, originalEnv);
  });

  it('should return default repos dir when not configured', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    const config = loadGitConfig();
    expect(config.reposDir).toBe('/data/repos');
  });

  it('should use custom repos dir from env var', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    process.env.GIT_REPOS_DIR = '/custom/repos';
    const config = loadGitConfig();
    expect(config.reposDir).toBe('/custom/repos');
  });

  it('should report enabled=true when feature flag is set', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    const config = loadGitConfig();
    expect(config.enabled).toBe(true);
  });

  it('should report enabled=false when feature flag is not set', () => {
    const config = loadGitConfig();
    expect(config.enabled).toBe(false);
  });

  it('should return the repo name', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    const config = loadGitConfig();
    expect(config.repoName).toBe('stacks');
  });

  it('should compute full repo path', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    process.env.GIT_REPOS_DIR = '/data/repos';
    const config = loadGitConfig();
    expect(config.repoPath).toBe('/data/repos/stacks.git');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/config/__tests__/git-config.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement git config**

Create `src/lib/config/git-config.ts`:

```typescript
import { z } from 'zod';
import { join } from 'path';

const GitConfigSchema = z.object({
  enabled: z.boolean(),
  reposDir: z.string(),
  repoName: z.string(),
  repoPath: z.string(),
});

export type GitConfig = z.infer<typeof GitConfigSchema>;

/**
 * Load git management configuration from environment variables.
 * Only active when DOCKER_MANAGEMENT_FEATURE_FLAG is set.
 *
 * @returns Validated git configuration
 */
export function loadGitConfig(): GitConfig {
  const enabled = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
  const reposDir = process.env.GIT_REPOS_DIR || '/data/repos';
  const repoName = 'stacks';
  const repoPath = join(reposDir, `${repoName}.git`);

  return GitConfigSchema.parse({ enabled, reposDir, repoName, repoPath });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/config/__tests__/git-config.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/config/git-config.ts src/lib/config/__tests__/git-config.test.ts
git commit -m "feat(git): add git config module with feature flag and repo path"
```

---

## Chunk 2: Manifest Schema & Parser

### Task 3: Manifest types and validation

**Files:**
- Create: `src/lib/git/manifest.ts`
- Create: `src/lib/git/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/manifest.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { parseManifest, type StackManifest } from '../manifest';

describe('parseManifest', () => {
  it('should parse a valid manifest YAML string', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
    auto_deploy: true
  traefik:
    host: homeserver
    auto_deploy: false
`;
    const result = parseManifest(yaml);
    expect(result.stacks.plex).toEqual({ host: 'homeserver', auto_deploy: true });
    expect(result.stacks.traefik).toEqual({ host: 'homeserver', auto_deploy: false });
  });

  it('should reject manifest with missing host', () => {
    const yaml = `
stacks:
  plex:
    auto_deploy: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should reject manifest with missing stacks key', () => {
    const yaml = `
something_else:
  plex:
    host: homeserver
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should default auto_deploy to false when omitted', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
`;
    const result = parseManifest(yaml);
    expect(result.stacks.plex.auto_deploy).toBe(false);
  });

  it('should reject invalid YAML', () => {
    const yaml = `{{{not yaml`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should parse manifest with multiple stacks on different hosts', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
    auto_deploy: true
  pihole:
    host: pihole-host
    auto_deploy: true
`;
    const result = parseManifest(yaml);
    expect(Object.keys(result.stacks)).toHaveLength(2);
    expect(result.stacks.pihole.host).toBe('pihole-host');
  });

  it('should reject stacks with empty host string', () => {
    const yaml = `
stacks:
  plex:
    host: ""
    auto_deploy: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/manifest.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement manifest parser**

Create `src/lib/git/manifest.ts`:

```typescript
import { z } from 'zod';
import yaml from 'js-yaml';

const StackEntrySchema = z.object({
  host: z.string().min(1),
  auto_deploy: z.boolean().default(false),
});

const ManifestSchema = z.object({
  stacks: z.record(z.string(), StackEntrySchema),
});

export type StackEntry = z.infer<typeof StackEntrySchema>;
export type StackManifest = z.infer<typeof ManifestSchema>;

/**
 * Parse and validate a manifest.yaml string.
 *
 * @param content - Raw YAML string
 * @returns Validated StackManifest
 * @throws {Error} If YAML is invalid or doesn't match schema
 */
export function parseManifest(content: string): StackManifest {
  const parsed = yaml.load(content);
  return ManifestSchema.parse(parsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/manifest.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/manifest.ts src/lib/git/__tests__/manifest.test.ts
git commit -m "feat(git): add manifest YAML parser with zod validation"
```

---

## Chunk 3: Git Repository Operations (isomorphic-git)

### Task 4: Repository initialization

**Files:**
- Create: `src/lib/git/repo.ts`
- Create: `src/lib/git/__tests__/repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/repo.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, repoExists } from '../repo';

describe('repo initialization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'git-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should initialize a bare git repo', async () => {
    const repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should be idempotent - calling init twice does not throw', async () => {
    const repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await initBareRepo(repoPath);
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should return false for non-existent repo', async () => {
    const repoPath = join(testDir, 'nonexistent.git');
    expect(await repoExists(repoPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/repo.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement repo initialization**

Create `src/lib/git/repo.ts`:

```typescript
import git from 'isomorphic-git';
import * as fs from 'fs';
import { existsSync, mkdirSync } from 'fs';

/**
 * Initialize a bare git repository at the given path.
 * Creates the directory if it does not exist.
 * Idempotent -- safe to call on an already-initialized repo.
 */
export async function initBareRepo(repoPath: string): Promise<void> {
  if (!existsSync(repoPath)) {
    mkdirSync(repoPath, { recursive: true });
  }

  await git.init({ fs, dir: repoPath, bare: true });
}

/**
 * Check whether a directory is a valid bare git repository.
 */
export async function repoExists(repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) {
    return false;
  }

  try {
    // A bare repo has HEAD at the top level
    await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    return true;
  } catch {
    // resolveRef throws if HEAD doesn't exist yet (empty repo)
    // but the repo can still be valid - check for HEAD file
    return existsSync(`${repoPath}/HEAD`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/repo.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/git/repo.ts src/lib/git/__tests__/repo.test.ts
git commit -m "feat(git): add bare repo init and existence check via isomorphic-git"
```

---

### Task 5: File reading from bare repo

**Files:**
- Modify: `src/lib/git/repo.ts`
- Modify: `src/lib/git/__tests__/repo.test.ts`

- [ ] **Step 1: Write the failing tests for file reading**

Append to `src/lib/git/__tests__/repo.test.ts`:

```typescript
import { readFileFromRepo, listFilesInRepo, commitFiles } from '../repo';

describe('readFileFromRepo', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-read-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    // Seed with a commit
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plexinc/pms-docker\n' },
      ],
      message: 'initial commit',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should read a file from the repo at HEAD', async () => {
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('stacks:');
    expect(content).toContain('plex:');
  });

  it('should read a nested file', async () => {
    const content = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(content).toContain('plexinc/pms-docker');
  });

  it('should throw for non-existent file', async () => {
    await expect(readFileFromRepo(repoPath, 'nonexistent.txt')).rejects.toThrow();
  });
});

describe('listFilesInRepo', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-list-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks: {}' },
        { path: 'plex/docker-compose.yml', content: 'services: {}' },
        { path: 'traefik/docker-compose.yml', content: 'services: {}' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should list all files at root', async () => {
    const files = await listFilesInRepo(repoPath);
    expect(files).toContain('manifest.yaml');
    expect(files).toContain('plex/docker-compose.yml');
    expect(files).toContain('traefik/docker-compose.yml');
  });

  it('should list files in a subdirectory', async () => {
    const files = await listFilesInRepo(repoPath, 'plex');
    expect(files).toEqual(['plex/docker-compose.yml']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/git/__tests__/repo.test.ts`
Expected: FAIL -- `readFileFromRepo`, `listFilesInRepo`, `commitFiles` not found

- [ ] **Step 3: Implement commitFiles, readFileFromRepo, and listFilesInRepo**

Add to `src/lib/git/repo.ts`:

```typescript
export interface FileEntry {
  path: string;
  content: string;
}

export interface CommitOptions {
  files: FileEntry[];
  message: string;
  author: { name: string; email: string };
}

/**
 * Commit files to a bare repository.
 * Builds a tree from scratch each time (full snapshot), writes it, and creates a commit
 * pointing to the current HEAD (if any) as parent.
 *
 * Note: This reads the entire existing tree into memory to overlay new files.
 * This is acceptable for v1 since repos only contain small compose files and manifests.
 * For optimization later, compare blob OIDs instead of reading content to skip unchanged files.
 */
export async function commitFiles(
  repoPath: string,
  options: CommitOptions,
): Promise<string> {
  const { files, message, author } = options;

  // Read existing tree if HEAD exists
  let existingFiles = new Map<string, string>();
  let parentCommit: string | undefined;
  try {
    parentCommit = await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    const { tree } = await git.readTree({ fs, gitdir: repoPath, oid: parentCommit });
    existingFiles = await readTreeRecursive(repoPath, tree, '');
  } catch {
    // No HEAD yet -- first commit
  }

  // Overlay new files onto existing files
  for (const file of files) {
    existingFiles.set(file.path, file.content);
  }

  // Build tree objects bottom-up
  const treeOid = await buildTree(repoPath, existingFiles);

  // Create commit
  const commitOid = await git.writeCommit({
    fs,
    gitdir: repoPath,
    commit: {
      message,
      tree: treeOid,
      parent: parentCommit ? [parentCommit] : [],
      author: {
        name: author.name,
        email: author.email,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: 0,
      },
      committer: {
        name: author.name,
        email: author.email,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: 0,
      },
    },
  });

  // Update HEAD -> main -> commitOid
  await git.writeRef({
    fs,
    gitdir: repoPath,
    ref: 'refs/heads/main',
    value: commitOid,
    force: true,
  });

  // Ensure HEAD points to refs/heads/main
  fs.writeFileSync(`${repoPath}/HEAD`, 'ref: refs/heads/main\n');

  return commitOid;
}

/**
 * Read a file's content from the repo at a given ref.
 * Note: `git.resolveRef` accepts both symbolic refs (e.g., 'HEAD', 'refs/heads/main')
 * and raw commit SHAs, so passing a commit OID directly works.
 */
export async function readFileFromRepo(
  repoPath: string,
  filePath: string,
  ref: string = 'HEAD',
): Promise<string> {
  const commitOid = await git.resolveRef({ fs, gitdir: repoPath, ref });
  const { tree } = await git.readTree({ fs, gitdir: repoPath, oid: commitOid });

  const parts = filePath.split('/');
  let currentTree = tree;

  // Navigate to parent directories
  for (let i = 0; i < parts.length - 1; i++) {
    const entry = currentTree.find((e) => e.path === parts[i] && e.type === 'tree');
    if (!entry) {
      throw new Error(`Path not found: ${filePath}`);
    }
    const subtree = await git.readTree({ fs, gitdir: repoPath, oid: entry.oid });
    currentTree = subtree.tree;
  }

  // Read the file blob
  const fileName = parts[parts.length - 1];
  const fileEntry = currentTree.find((e) => e.path === fileName && e.type === 'blob');
  if (!fileEntry) {
    throw new Error(`File not found: ${filePath}`);
  }

  const { blob } = await git.readBlob({ fs, gitdir: repoPath, oid: fileEntry.oid });
  return new TextDecoder().decode(blob);
}

/**
 * List files in the repo, optionally filtered by directory prefix.
 */
export async function listFilesInRepo(
  repoPath: string,
  prefix?: string,
  ref: string = 'HEAD',
): Promise<string[]> {
  const commitOid = await git.resolveRef({ fs, gitdir: repoPath, ref });
  const { tree } = await git.readTree({ fs, gitdir: repoPath, oid: commitOid });

  const allFiles = await collectFilePaths(repoPath, tree, '');

  if (prefix) {
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return allFiles.filter((f) => f.startsWith(normalizedPrefix));
  }

  return allFiles;
}

/** Recursively read all files from a tree into a Map<path, content>. */
async function readTreeRecursive(
  repoPath: string,
  tree: git.TreeEntry[],
  prefix: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  for (const entry of tree) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      const { blob } = await git.readBlob({ fs, gitdir: repoPath, oid: entry.oid });
      files.set(fullPath, new TextDecoder().decode(blob));
    } else if (entry.type === 'tree') {
      const subtree = await git.readTree({ fs, gitdir: repoPath, oid: entry.oid });
      const subFiles = await readTreeRecursive(repoPath, subtree.tree, fullPath);
      for (const [k, v] of subFiles) {
        files.set(k, v);
      }
    }
  }

  return files;
}

/** Recursively collect file paths from a tree. */
async function collectFilePaths(
  repoPath: string,
  tree: git.TreeEntry[],
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];

  for (const entry of tree) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      paths.push(fullPath);
    } else if (entry.type === 'tree') {
      const subtree = await git.readTree({ fs, gitdir: repoPath, oid: entry.oid });
      const subPaths = await collectFilePaths(repoPath, subtree.tree, fullPath);
      paths.push(...subPaths);
    }
  }

  return paths;
}

/** Build a git tree object from a flat map of file paths to contents. */
async function buildTree(
  repoPath: string,
  files: Map<string, string>,
): Promise<string> {
  // Group files by top-level directory or filename
  const entries = new Map<string, Map<string, string> | string>();

  for (const [filePath, content] of files) {
    const parts = filePath.split('/');
    if (parts.length === 1) {
      entries.set(parts[0], content);
    } else {
      const dir = parts[0];
      const rest = parts.slice(1).join('/');
      if (!entries.has(dir)) {
        entries.set(dir, new Map());
      }
      (entries.get(dir) as Map<string, string>).set(rest, content);
    }
  }

  // Build tree entries
  const treeEntries: { mode: string; path: string; oid: string }[] = [];

  for (const [name, value] of entries) {
    if (typeof value === 'string') {
      // Write blob
      const oid = await git.writeBlob({
        fs,
        gitdir: repoPath,
        blob: new TextEncoder().encode(value),
      });
      treeEntries.push({ mode: '100644', path: name, oid });
    } else {
      // Recurse into subdirectory
      const subtreeOid = await buildTree(repoPath, value);
      treeEntries.push({ mode: '040000', path: name, oid: subtreeOid });
    }
  }

  // Sort entries by name (git requirement)
  treeEntries.sort((a, b) => a.path.localeCompare(b.path));

  return await git.writeTree({
    fs,
    gitdir: repoPath,
    tree: treeEntries.map((e) => ({
      mode: e.mode,
      path: e.path,
      oid: e.oid,
      type: e.mode === '040000' ? 'tree' : 'blob',
    })),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/git/__tests__/repo.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/repo.ts src/lib/git/__tests__/repo.test.ts
git commit -m "feat(git): add file commit, read, and list operations for bare repos"
```

---

### Task 6: Commit log and diff operations

**Files:**
- Modify: `src/lib/git/repo.ts`
- Create: `src/lib/git/__tests__/repo-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/repo-diff.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles, getLog, diffCommits } from '../repo';

describe('getLog', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-log-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return commit log entries', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'file.txt', content: 'hello' }],
      message: 'first commit',
      author: { name: 'test', email: 'test@test.com' },
    });

    await commitFiles(repoPath, {
      files: [{ path: 'file.txt', content: 'world' }],
      message: 'second commit',
      author: { name: 'test', email: 'test@test.com' },
    });

    const log = await getLog(repoPath, 10);
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('second commit');
    expect(log[1].message).toBe('first commit');
  });

  it('should respect depth limit', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'a.txt', content: 'a' }],
      message: 'first',
      author: { name: 'test', email: 'test@test.com' },
    });
    await commitFiles(repoPath, {
      files: [{ path: 'b.txt', content: 'b' }],
      message: 'second',
      author: { name: 'test', email: 'test@test.com' },
    });
    await commitFiles(repoPath, {
      files: [{ path: 'c.txt', content: 'c' }],
      message: 'third',
      author: { name: 'test', email: 'test@test.com' },
    });

    const log = await getLog(repoPath, 2);
    expect(log).toHaveLength(2);
  });
});

describe('diffCommits', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-diff-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect changed files between two commits', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks: {}' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    });

    const changed = await diffCommits(repoPath, sha1, sha2);
    expect(changed).toContain('plex/docker-compose.yml');
    expect(changed).not.toContain('manifest.yaml');
  });

  it('should detect new files', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [{ path: 'manifest.yaml', content: 'stacks: {}' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'traefik/docker-compose.yml', content: 'services: {}' }],
      message: 'add traefik',
      author: { name: 'test', email: 'test@test.com' },
    });

    const changed = await diffCommits(repoPath, sha1, sha2);
    expect(changed).toContain('traefik/docker-compose.yml');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/repo-diff.test.ts`
Expected: FAIL -- `getLog`, `diffCommits` not found

- [ ] **Step 3: Implement getLog and diffCommits**

Add to `src/lib/git/repo.ts`:

```typescript
export interface LogEntry {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
}

/**
 * Get the commit log for the repository.
 */
export async function getLog(
  repoPath: string,
  depth: number = 20,
  ref: string = 'HEAD',
): Promise<LogEntry[]> {
  const commits = await git.log({ fs, gitdir: repoPath, ref, depth });
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: {
      name: c.commit.author.name,
      email: c.commit.author.email,
      timestamp: c.commit.author.timestamp,
    },
  }));
}

/**
 * Diff two commits and return a list of changed file paths.
 * Compares the full trees of both commits.
 */
export async function diffCommits(
  repoPath: string,
  fromOid: string,
  toOid: string,
): Promise<string[]> {
  const fromCommit = await git.readCommit({ fs, gitdir: repoPath, oid: fromOid });
  const toCommit = await git.readCommit({ fs, gitdir: repoPath, oid: toOid });

  const fromTree = await git.readTree({ fs, gitdir: repoPath, oid: fromCommit.commit.tree });
  const toTree = await git.readTree({ fs, gitdir: repoPath, oid: toCommit.commit.tree });

  const fromFiles = await flattenTree(repoPath, fromTree.tree, '');
  const toFiles = await flattenTree(repoPath, toTree.tree, '');

  const changed: string[] = [];

  // Check for modified or added files
  for (const [path, oid] of toFiles) {
    const fromOidValue = fromFiles.get(path);
    if (fromOidValue !== oid) {
      changed.push(path);
    }
  }

  // Check for deleted files
  for (const [path] of fromFiles) {
    if (!toFiles.has(path)) {
      changed.push(path);
    }
  }

  return changed.sort();
}

/** Flatten a tree into a Map<filePath, blobOid>. */
async function flattenTree(
  repoPath: string,
  tree: git.TreeEntry[],
  prefix: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const entry of tree) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      result.set(fullPath, entry.oid);
    } else if (entry.type === 'tree') {
      const subtree = await git.readTree({ fs, gitdir: repoPath, oid: entry.oid });
      const subFiles = await flattenTree(repoPath, subtree.tree, fullPath);
      for (const [k, v] of subFiles) {
        result.set(k, v);
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/repo-diff.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/repo.ts src/lib/git/__tests__/repo-diff.test.ts
git commit -m "feat(git): add commit log and tree diff operations"
```

---

## Chunk 4: Post-Receive Change Detection

### Task 7: Changed stacks identification

**Files:**
- Create: `src/lib/git/post-receive.ts`
- Create: `src/lib/git/__tests__/post-receive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/post-receive.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import {
  identifyChangedStacks,
  buildDeployRequests,
  type DeployRequest,
} from '../post-receive';

describe('identifyChangedStacks', () => {
  it('should extract stack names from changed file paths', () => {
    const changedFiles = [
      'plex/docker-compose.yml',
      'traefik/docker-compose.yml',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex', 'traefik']);
  });

  it('should deduplicate when multiple files in same stack change', () => {
    const changedFiles = [
      'plex/docker-compose.yml',
      'plex/.env',
      'plex/config/settings.json',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex']);
  });

  it('should ignore root-level files (manifest.yaml)', () => {
    const changedFiles = ['manifest.yaml', 'plex/docker-compose.yml'];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex']);
  });

  it('should return empty array for no stack changes', () => {
    const changedFiles = ['manifest.yaml', 'README.md'];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual([]);
  });

  it('should sort stack names', () => {
    const changedFiles = [
      'traefik/docker-compose.yml',
      'pihole/docker-compose.yml',
      'plex/docker-compose.yml',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['pihole', 'plex', 'traefik']);
  });
});

describe('buildDeployRequests', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-deploy-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should build deploy requests for auto_deploy stacks', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n  traefik:\n    host: homeserver\n    auto_deploy: false\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v1\n' },
        { path: 'traefik/docker-compose.yml', content: 'services:\n  traefik:\n    image: traefik:v1\n' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v2\n' },
        { path: 'traefik/docker-compose.yml', content: 'services:\n  traefik:\n    image: traefik:v2\n' },
      ],
      message: 'update both stacks',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await buildDeployRequests(repoPath, sha1, sha2);

    const plexReq = requests.find((r) => r.stack === 'plex');
    const traefikReq = requests.find((r) => r.stack === 'traefik');

    expect(plexReq).toBeDefined();
    expect(plexReq!.autoApproved).toBe(true);
    expect(plexReq!.host).toBe('homeserver');
    expect(plexReq!.commitSha).toBe(sha2);
    expect(plexReq!.action).toBe('deploy');

    expect(traefikReq).toBeDefined();
    expect(traefikReq!.autoApproved).toBe(false);
  });

  it('should skip stacks not in manifest', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'unknown/docker-compose.yml', content: 'services: {}' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'unknown/docker-compose.yml', content: 'services: {updated: true}' }],
      message: 'update unknown',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await buildDeployRequests(repoPath, sha1, sha2);
    expect(requests).toHaveLength(0);
  });

  it('should include compose path in deploy request', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await buildDeployRequests(repoPath, sha1, sha2);
    expect(requests[0].composePath).toBe('plex/docker-compose.yml');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/post-receive.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement post-receive logic**

Create `src/lib/git/post-receive.ts`:

```typescript
import { diffCommits, readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';

export interface DeployRequest {
  stack: string;
  host: string;
  composePath: string;
  commitSha: string;
  secrets: Record<string, string>;
  action: 'deploy' | 'teardown' | 'restart';
  autoApproved: boolean;
}

/**
 * Extract unique top-level directory names from changed file paths.
 * Root-level files (no `/`) are ignored -- only stack directories matter.
 */
export function identifyChangedStacks(changedFiles: string[]): string[] {
  const stacks = new Set<string>();

  for (const filePath of changedFiles) {
    const parts = filePath.split('/');
    if (parts.length >= 2) {
      stacks.add(parts[0]);
    }
  }

  return Array.from(stacks).sort();
}

/**
 * After a push, diff the commits, parse the manifest, and build deploy requests
 * for each changed stack that exists in the manifest.
 */
export async function buildDeployRequests(
  repoPath: string,
  fromOid: string,
  toOid: string,
): Promise<DeployRequest[]> {
  // 1. Diff the commits to find changed files
  const changedFiles = await diffCommits(repoPath, fromOid, toOid);

  // 2. Identify which stacks have changes
  const changedStacks = identifyChangedStacks(changedFiles);

  if (changedStacks.length === 0) {
    return [];
  }

  // 3. Read and parse manifest from the new commit
  const manifestContent = await readFileFromRepo(repoPath, 'manifest.yaml', toOid);
  const manifest = parseManifest(manifestContent);

  // 4. Build deploy requests for stacks that exist in the manifest
  const requests: DeployRequest[] = [];

  for (const stackName of changedStacks) {
    const stackConfig = manifest.stacks[stackName];
    if (!stackConfig) {
      // Stack directory changed but not in manifest -- skip
      continue;
    }

    requests.push({
      stack: stackName,
      host: stackConfig.host,
      composePath: `${stackName}/docker-compose.yml`,
      commitSha: toOid,
      secrets: {},
      action: 'deploy',
      autoApproved: stackConfig.auto_deploy,
    });
  }

  return requests;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/post-receive.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/post-receive.ts src/lib/git/__tests__/post-receive.test.ts
git commit -m "feat(git): add post-receive change detection and deploy request builder"
```

---

## Chunk 5: Git HTTP Smart Protocol Server

### Task 8: Git info/refs endpoint

**Files:**
- Create: `src/routes/api/git.$.ts`
- Create: `src/lib/git/__tests__/git-http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/git-http.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  parseGitPath,
  isGitInfoRefsRequest,
  isGitUploadPackRequest,
  isGitReceivePackRequest,
} from '../git-http';

describe('parseGitPath', () => {
  it('should parse info/refs path', () => {
    const result = parseGitPath('/api/git/stacks/info/refs');
    expect(result).toEqual({ repo: 'stacks', action: 'info/refs' });
  });

  it('should parse git-upload-pack path', () => {
    const result = parseGitPath('/api/git/stacks/git-upload-pack');
    expect(result).toEqual({ repo: 'stacks', action: 'git-upload-pack' });
  });

  it('should parse git-receive-pack path', () => {
    const result = parseGitPath('/api/git/stacks/git-receive-pack');
    expect(result).toEqual({ repo: 'stacks', action: 'git-receive-pack' });
  });

  it('should return null for invalid path', () => {
    const result = parseGitPath('/api/git/');
    expect(result).toBeNull();
  });

  it('should return null for unknown action', () => {
    const result = parseGitPath('/api/git/stacks/unknown');
    expect(result).toBeNull();
  });
});

describe('request type checks', () => {
  it('should identify info/refs GET request', () => {
    expect(isGitInfoRefsRequest('GET', 'info/refs')).toBe(true);
    expect(isGitInfoRefsRequest('POST', 'info/refs')).toBe(false);
  });

  it('should identify upload-pack POST request', () => {
    expect(isGitUploadPackRequest('POST', 'git-upload-pack')).toBe(true);
    expect(isGitUploadPackRequest('GET', 'git-upload-pack')).toBe(false);
  });

  it('should identify receive-pack POST request', () => {
    expect(isGitReceivePackRequest('POST', 'git-receive-pack')).toBe(true);
    expect(isGitReceivePackRequest('GET', 'git-receive-pack')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/git-http.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement git-http utilities**

Create `src/lib/git/git-http.ts`:

```typescript
const VALID_ACTIONS = ['info/refs', 'git-upload-pack', 'git-receive-pack'] as const;
type GitAction = (typeof VALID_ACTIONS)[number];

export interface GitPathInfo {
  repo: string;
  action: GitAction;
}

/**
 * Parse a Git HTTP path like `/api/git/stacks/info/refs` into repo name and action.
 */
export function parseGitPath(pathname: string): GitPathInfo | null {
  // Remove the /api/git/ prefix
  const prefix = '/api/git/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const rest = pathname.slice(prefix.length);

  // Try each valid action (longest first to match info/refs before other patterns)
  for (const action of VALID_ACTIONS) {
    if (rest.endsWith(`/${action}`)) {
      const repo = rest.slice(0, -(action.length + 1));
      if (repo.length > 0) {
        return { repo, action };
      }
    }
  }

  return null;
}

export function isGitInfoRefsRequest(method: string, action: string): boolean {
  return method === 'GET' && action === 'info/refs';
}

export function isGitUploadPackRequest(method: string, action: string): boolean {
  return method === 'POST' && action === 'git-upload-pack';
}

export function isGitReceivePackRequest(method: string, action: string): boolean {
  return method === 'POST' && action === 'git-receive-pack';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/git-http.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/git/git-http.ts src/lib/git/__tests__/git-http.test.ts
git commit -m "feat(git): add Git HTTP path parser and request type utilities"
```

---

### Task 9: Git HTTP server route

**Files:**
- Create: `src/routes/api/git.$.ts`
- Create: `src/lib/git/git-server.ts`
- Create: `src/lib/git/__tests__/git-server.test.ts`
- Modify: `Dockerfile` (add git to container image)

- [ ] **Step 1: Write the failing test for git-server**

Create `src/lib/git/__tests__/git-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from '../git-server';

describe('handleInfoRefs', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-server-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return info/refs for upload-pack service', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const response = await handleInfoRefs(repoPath, 'git-upload-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-upload-pack-advertisement');
  });

  it('should return info/refs for receive-pack service', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const response = await handleInfoRefs(repoPath, 'git-receive-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-receive-pack-advertisement');
  });

  it('should return 400 for invalid service', async () => {
    const response = await handleInfoRefs(repoPath, 'invalid');
    expect(response.status).toBe(400);
  });
});

describe('handleUploadPack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-upload-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return correct content type', async () => {
    // Create a minimal upload-pack request body
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleUploadPack(repoPath, body);
    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-upload-pack-result');
  });
});

describe('handleReceivePack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-receive-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return correct content type', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleReceivePack(repoPath, body);
    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-receive-pack-result');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/git-server.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement git-server**

Create `src/lib/git/git-server.ts`:

```typescript
/**
 * Git HTTP smart protocol handlers.
 * Shells out to `git upload-pack` and `git receive-pack` via Bun.spawn().
 * This is a server-only module (uses Bun.spawn), so static imports are fine.
 * Dynamic imports are only needed in route files to avoid client bundle pollution.
 */
import git from 'isomorphic-git';
import fs from 'fs';

const VALID_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;

/**
 * Handle GET /info/refs?service=<service>
 * Returns ref advertisement for the requested service.
 */
export async function handleInfoRefs(
  repoPath: string,
  service: string,
): Promise<Response> {
  if (!VALID_SERVICES.includes(service as (typeof VALID_SERVICES)[number])) {
    return new Response('Invalid service', { status: 400 });
  }

  const proc = Bun.spawn([service, '--stateless-rpc', '--advertise-refs', repoPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).arrayBuffer();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`[GitServer] ${service} --advertise-refs failed:`, stderr);
    return new Response('Internal server error', { status: 500 });
  }

  // Smart HTTP protocol requires a pkt-line header before the advertisement
  const serviceLine = `# service=${service}\n`;
  const pktLine = pktLineEncode(serviceLine);
  const flush = '0000';

  const header = new TextEncoder().encode(pktLine + flush);
  const body = new Uint8Array(header.length + stdout.byteLength);
  body.set(header);
  body.set(new Uint8Array(stdout), header.length);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': `application/x-${service}-advertisement`,
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Handle POST /git-upload-pack (client clone/fetch).
 */
export async function handleUploadPack(
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  return runGitService('git-upload-pack', repoPath, body);
}

/**
 * Handle POST /git-receive-pack (client push).
 * Returns the response; post-receive logic runs after.
 */
export async function handleReceivePack(
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  return runGitService('git-receive-pack', repoPath, body);
}

/**
 * Get HEAD ref before a receive-pack to enable post-receive diffing.
 */
export async function getHeadOid(repoPath: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
  } catch {
    return null;
  }
}

async function runGitService(
  service: string,
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  const stdinBuffer = body ? await streamToBuffer(body) : undefined;

  const proc = Bun.spawn([service, '--stateless-rpc', repoPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Bun.spawn() does not accept a Buffer for stdin directly.
  // Instead, spawn with stdin: "pipe", write the buffer, and close.
  if (stdinBuffer && proc.stdin) {
    proc.stdin.write(stdinBuffer);
  }
  if (proc.stdin) {
    proc.stdin.end();
  }

  const stdout = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;

  return new Response(stdout, {
    status: 200,
    headers: {
      'Content-Type': `application/x-${service}-result`,
      'Cache-Control': 'no-cache',
    },
  });
}

/** Encode a string as a git pkt-line. */
function pktLineEncode(str: string): string {
  const length = str.length + 4;
  return length.toString(16).padStart(4, '0') + str;
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/git-server.test.ts`
Expected: All tests pass (requires `git` binary on PATH)

> **Note:** These are smoke tests that verify correct content types and basic response codes. Real git protocol testing (actual `git clone`, `git push` round-trips) requires integration tests with a running server and a git client, which is out of scope for unit tests.

- [ ] **Step 5: Create the TanStack Router route**

Create `src/routes/api/git.$.ts`:

```typescript
import { createFileRoute } from '@tanstack/react-router';

/**
 * Authenticate git HTTP requests via Bearer token.
 * CRITICAL: Pushes can trigger auto-deploys, so this endpoint must be authenticated.
 * Uses GIT_SERVER_TOKEN env var. Returns null if authenticated, or an error Response.
 */
function authenticateRequest(request: Request): Response | null {
  const token = process.env.GIT_SERVER_TOKEN;
  if (!token) {
    // If no token is configured, reject all requests for safety
    return new Response('Git server token not configured', { status: 500 });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }

  const providedToken = authHeader.slice('Bearer '.length);
  if (providedToken !== token) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

export const Route = createFileRoute('/api/git/$')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (process.env.DOCKER_MANAGEMENT_FEATURE_FLAG !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const authError = authenticateRequest(request);
        if (authError) return authError;

        const { loadGitConfig } = await import('@/lib/config/git-config');
        const { parseGitPath, isGitInfoRefsRequest } = await import(
          '@/lib/git/git-http'
        );
        const { handleInfoRefs } = await import('@/lib/git/git-server');
        const { initBareRepo } = await import('@/lib/git/repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        if (!isGitInfoRefsRequest('GET', pathInfo.action)) {
          return new Response('Method Not Allowed', { status: 405 });
        }

        const config = loadGitConfig();
        const repoPath = config.repoPath;

        // Ensure repo exists
        await initBareRepo(repoPath);

        const service = url.searchParams.get('service');
        if (!service) {
          return new Response('Service parameter required', { status: 400 });
        }

        return handleInfoRefs(repoPath, service);
      },

      // NOTE: Post-receive wiring is added in Task 10 Step 5 after
      // post-receive-handler.ts exists. This initial version handles
      // only upload-pack and receive-pack without post-receive hooks.
      POST: async ({ request }) => {
        if (process.env.DOCKER_MANAGEMENT_FEATURE_FLAG !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const authError = authenticateRequest(request);
        if (authError) return authError;

        const { loadGitConfig } = await import('@/lib/config/git-config');
        const {
          parseGitPath,
          isGitUploadPackRequest,
          isGitReceivePackRequest,
        } = await import('@/lib/git/git-http');
        const {
          handleUploadPack,
          handleReceivePack,
        } = await import('@/lib/git/git-server');
        const { initBareRepo } = await import('@/lib/git/repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        const config = loadGitConfig();
        const repoPath = config.repoPath;

        await initBareRepo(repoPath);

        if (isGitUploadPackRequest('POST', pathInfo.action)) {
          return handleUploadPack(repoPath, request.body);
        }

        if (isGitReceivePackRequest('POST', pathInfo.action)) {
          return handleReceivePack(repoPath, request.body);
        }

        return new Response('Not Found', { status: 404 });
      },
    },
  },
});
```

- [ ] **Step 6: Add git to the Dockerfile**

Modify `Dockerfile` to install git in the **final runtime stage** (not just the deps/build stage). The `git` binary is needed at runtime for `git upload-pack` and `git receive-pack` via `Bun.spawn()`. Check the existing Dockerfile for the final stage name and add:

```dockerfile
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
```

to the final runtime stage. If the final stage uses a minimal base image (e.g., `oven/bun:1-slim` or `distroless`), ensure `git` is available there, not just in intermediate build stages that get discarded.

- [ ] **Step 7: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors (note: route file is auto-generated in `routeTree.gen.ts` by TanStack Router plugin; typecheck may need a dev server run first to regenerate)

- [ ] **Step 8: Commit**

```bash
git add src/routes/api/git.$.ts src/lib/git/git-server.ts src/lib/git/__tests__/git-server.test.ts Dockerfile
git commit -m "feat(git): add Git HTTP smart protocol server route with upload-pack and receive-pack"
```

---

## Chunk 6: Post-Receive Handler & Repo Initialization

### Task 10: Post-receive handler (orchestration layer)

**Files:**
- Create: `src/lib/git/post-receive-handler.ts`
- Create: `src/lib/git/__tests__/post-receive-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/post-receive-handler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { processPostReceive } from '../post-receive-handler';

describe('processPostReceive', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-handler-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return deploy requests for changed stacks', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await processPostReceive(repoPath, sha1, sha2);
    expect(requests).toHaveLength(1);
    expect(requests[0].stack).toBe('plex');
    expect(requests[0].autoApproved).toBe(true);
  });

  it('should handle manifest-only changes gracefully', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: false\n' },
      ],
      message: 'update manifest only',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await processPostReceive(repoPath, sha1, sha2);
    expect(requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/post-receive-handler.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement post-receive handler**

Create `src/lib/git/post-receive-handler.ts`:

```typescript
import { buildDeployRequests, type DeployRequest } from '@/lib/git/post-receive';

/**
 * Process a post-receive event after a git push.
 * Diffs the old and new HEAD, builds deploy requests, and returns them.
 *
 * In the future this will dispatch to the deploy pipeline.
 * For now it returns the requests for the caller to handle.
 */
export async function processPostReceive(
  repoPath: string,
  oldHead: string,
  newHead: string,
): Promise<DeployRequest[]> {
  const requests = await buildDeployRequests(repoPath, oldHead, newHead);

  // TODO: Dispatch to deploy pipeline
  // For auto-approved requests: send directly to pipeline
  // For manual-approval requests: create pending deploy record in PostgreSQL

  return requests;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/post-receive-handler.test.ts`
Expected: All tests pass

- [ ] **Step 5: Wire post-receive handler into the git route**

Now that `post-receive-handler.ts` exists, update `src/routes/api/git.$.ts` POST handler to import and call it. Replace the POST handler's receive-pack branch with:

```typescript
        if (isGitReceivePackRequest('POST', pathInfo.action)) {
          const { getHeadOid } = await import('@/lib/git/git-server');
          const { processPostReceive } = await import(
            '@/lib/git/post-receive-handler'
          );

          // Capture HEAD before push for diffing
          const oldHead = await getHeadOid(repoPath);

          const response = await handleReceivePack(repoPath, request.body);

          // Post-receive: diff and trigger deploys (non-blocking)
          const newHead = await getHeadOid(repoPath);
          if (oldHead && newHead && oldHead !== newHead) {
            processPostReceive(repoPath, oldHead, newHead).catch((err) => {
              console.error('[GitServer] Post-receive error:', err);
            });
          }

          return response;
        }
```

Also add `handleReceivePack` to the existing `git-server` import at the top of the POST handler.

> **Note on error visibility (Issue 7):** The `.catch(console.error)` pattern means post-receive errors (e.g., deploy failures) are only visible in server logs. The git protocol does not support sending error details back to the client after the pack response has already been sent. Deploy failures should instead be tracked via the `deploy_history` table and surfaced in the UI dashboard, which will be implemented in the deploy pipeline chunk.

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/post-receive-handler.ts src/lib/git/__tests__/post-receive-handler.test.ts src/routes/api/git.$.ts
git commit -m "feat(git): add post-receive handler for push event orchestration"
```

---

### Task 11: Repo initialization on startup

**Files:**
- Create: `src/lib/git/init-repo.ts`
- Create: `src/lib/git/__tests__/init-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/init-repo.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureRepoInitialized } from '../init-repo';
import { repoExists, readFileFromRepo } from '../repo';

describe('ensureRepoInitialized', () => {
  let testDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'git-init-'));
    process.env.GIT_REPOS_DIR = testDir;
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    Object.assign(process.env, originalEnv);
  });

  it('should initialize a bare repo if it does not exist', async () => {
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should create initial manifest.yaml with empty stacks', async () => {
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('stacks:');
  });

  it('should be idempotent', async () => {
    await ensureRepoInitialized();
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should do nothing when feature flag is off', async () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(existsSync(repoPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/init-repo.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement repo initialization**

Create `src/lib/git/init-repo.ts`:

```typescript
import git from 'isomorphic-git';
import fs from 'fs';
import { loadGitConfig } from '@/lib/config/git-config';
import { initBareRepo, repoExists, commitFiles } from '@/lib/git/repo';

const DEFAULT_MANIFEST = `stacks: {}
`;

/**
 * Ensure the stacks git repository is initialized.
 * Called on server startup when DOCKER_MANAGEMENT_FEATURE_FLAG is enabled.
 * Creates the bare repo and seeds it with an empty manifest if it doesn't exist.
 */
export async function ensureRepoInitialized(): Promise<void> {
  const config = loadGitConfig();

  if (!config.enabled) {
    return;
  }

  const { repoPath } = config;

  await initBareRepo(repoPath);

  // Check if repo has any commits; if not, seed with initial manifest
  // repoExists checks for HEAD file but not whether HEAD resolves to a commit.
  // Use resolveRef to determine if there are actual commits.
  const hasCommits = await hasAnyCommits(repoPath);
  if (!hasCommits) {
    await commitFiles(repoPath, {
      files: [{ path: 'manifest.yaml', content: DEFAULT_MANIFEST }],
      message: 'Initialize stacks repository',
      author: {
        name: 'homelab-manager',
        email: 'homelab-manager@localhost',
      },
    });
  }
}

async function hasAnyCommits(repoPath: string): Promise<boolean> {
  try {
    await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/init-repo.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/init-repo.ts src/lib/git/__tests__/init-repo.test.ts
git commit -m "feat(git): add repo initialization with seed manifest on startup"
```

---

## Chunk 7: In-App File Writing (Commit from UI)

### Task 12: Write files and commit from UI context

**Files:**
- Create: `src/lib/git/editor-operations.ts`
- Create: `src/lib/git/__tests__/editor-operations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/editor-operations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles, readFileFromRepo, getLog } from '../repo';
import { saveAndCommitFile, updateManifest } from '../editor-operations';

describe('saveAndCommitFile', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-editor-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v1\n' },
      ],
      message: 'initial',
      author: { name: 'system', email: 'system@localhost' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should save a file and create a commit', async () => {
    const newContent = 'services:\n  plex:\n    image: plex:v2\n';
    const result = await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: newContent,
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Update plex to v2',
    });

    expect(result.commitSha).toBeDefined();
    expect(result.commitSha.length).toBe(40);

    const saved = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(saved).toBe(newContent);
  });

  it('should create a new file in a new stack directory', async () => {
    const result = await saveAndCommitFile(repoPath, {
      filePath: 'traefik/docker-compose.yml',
      content: 'services:\n  traefik:\n    image: traefik:v3\n',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Add traefik stack',
    });

    expect(result.commitSha).toBeDefined();
    const saved = await readFileFromRepo(repoPath, 'traefik/docker-compose.yml');
    expect(saved).toContain('traefik:v3');
  });

  it('should preserve existing files when writing a new one', async () => {
    await saveAndCommitFile(repoPath, {
      filePath: 'traefik/docker-compose.yml',
      content: 'services: {}',
      author: { name: 'test', email: 'test@test.com' },
      message: 'add traefik',
    });

    // Original file should still exist
    const plex = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(plex).toContain('plex:v1');
  });

  it('should use provided commit message', async () => {
    await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: 'updated',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Custom commit message',
    });

    const log = await getLog(repoPath, 1);
    expect(log[0].message).toBe('Custom commit message');
  });
});

describe('updateManifest', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-manifest-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
      ],
      message: 'initial',
      author: { name: 'system', email: 'system@localhost' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should add a new stack to the manifest', async () => {
    const result = await updateManifest(repoPath, {
      stackName: 'traefik',
      host: 'homeserver',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    expect(result.commitSha).toBeDefined();
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('traefik:');
    expect(content).toContain('homeserver');
  });

  it('should update an existing stack in the manifest', async () => {
    const result = await updateManifest(repoPath, {
      stackName: 'plex',
      host: 'new-host',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    expect(result.commitSha).toBeDefined();
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('new-host');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/editor-operations.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement editor operations**

Create `src/lib/git/editor-operations.ts`:

```typescript
import yaml from 'js-yaml';
import { commitFiles, readFileFromRepo } from '@/lib/git/repo';
import { parseManifest, type StackManifest } from '@/lib/git/manifest';

interface SaveFileOptions {
  filePath: string;
  content: string;
  author: { name: string; email: string };
  message: string;
}

interface SaveResult {
  commitSha: string;
}

/**
 * Save a file to the repo and create a commit.
 * Used by the in-app editor for compose file edits.
 */
export async function saveAndCommitFile(
  repoPath: string,
  options: SaveFileOptions,
): Promise<SaveResult> {
  const commitSha = await commitFiles(repoPath, {
    files: [{ path: options.filePath, content: options.content }],
    message: options.message,
    author: options.author,
  });

  return { commitSha };
}

interface UpdateManifestOptions {
  stackName: string;
  host: string;
  autoDeploy: boolean;
  author: { name: string; email: string };
}

/**
 * Add or update a stack entry in manifest.yaml and commit.
 */
export async function updateManifest(
  repoPath: string,
  options: UpdateManifestOptions,
): Promise<SaveResult> {
  // Read current manifest
  const manifestContent = await readFileFromRepo(repoPath, 'manifest.yaml');
  const manifest = parseManifest(manifestContent);

  // Update the stack entry
  manifest.stacks[options.stackName] = {
    host: options.host,
    auto_deploy: options.autoDeploy,
  };

  // Serialize back to YAML
  const newContent = yaml.dump(manifest, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
  });

  const commitSha = await commitFiles(repoPath, {
    files: [{ path: 'manifest.yaml', content: newContent }],
    message: `Update manifest: ${options.stackName} on ${options.host}`,
    author: options.author,
  });

  return { commitSha };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/editor-operations.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/editor-operations.ts src/lib/git/__tests__/editor-operations.test.ts
git commit -m "feat(git): add in-app file save, commit, and manifest update operations"
```

---

## Chunk 8: Server Functions for Frontend Access

### Task 13: Git server functions

**Files:**
- Create: `src/lib/git/git-server-functions.ts`
- Create: `src/lib/git/__tests__/git-server-functions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/git/__tests__/git-server-functions.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  buildFileTree,
  type FileTreeNode,
} from '../git-server-functions';

describe('buildFileTree', () => {
  it('should build a tree from flat file paths', () => {
    const files = [
      'manifest.yaml',
      'plex/docker-compose.yml',
      'traefik/docker-compose.yml',
      'traefik/config/traefik.yml',
    ];

    const tree = buildFileTree(files);

    expect(tree).toHaveLength(3);

    const manifest = tree.find((n) => n.name === 'manifest.yaml');
    expect(manifest).toBeDefined();
    expect(manifest!.type).toBe('file');

    const plex = tree.find((n) => n.name === 'plex');
    expect(plex).toBeDefined();
    expect(plex!.type).toBe('directory');
    expect(plex!.children).toHaveLength(1);

    const traefik = tree.find((n) => n.name === 'traefik');
    expect(traefik).toBeDefined();
    expect(traefik!.children).toHaveLength(2);
  });

  it('should sort directories before files', () => {
    const files = ['b.txt', 'a/c.txt'];
    const tree = buildFileTree(files);
    expect(tree[0].name).toBe('a');
    expect(tree[1].name).toBe('b.txt');
  });

  it('should handle empty file list', () => {
    const tree = buildFileTree([]);
    expect(tree).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/git/__tests__/git-server-functions.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement server functions module**

Create `src/lib/git/git-server-functions.ts`:

```typescript
/**
 * Server functions for git operations.
 * These are called from the frontend via createServerFn (future task)
 * and contain the shared utility logic.
 *
 * All modules that use isomorphic-git, fs, or other server-only packages
 * must be dynamically imported inside the server function body.
 */

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: FileTreeNode[];
}

/**
 * Build a nested file tree structure from flat file paths.
 * Used by the UI to display the repository file browser.
 */
export function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          children: [],
        };
        currentLevel.push(existing);
      }
      currentLevel = existing.children;
    }
  }

  // Sort recursively: directories first, then alphabetically
  sortTree(root);
  return root;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/git/__tests__/git-server-functions.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/git-server-functions.ts src/lib/git/__tests__/git-server-functions.test.ts
git commit -m "feat(git): add file tree builder utility for UI file browser"
```

---

## Chunk 9: Environment Variable & Dockerfile Updates

### Task 14: Update .env.example and Dockerfile

**Files:**
- Modify: `.env.example`
- Modify: `Dockerfile`

- [ ] **Step 1: Add git management env vars to `.env.example`**

Append the following to `.env.example`:

```bash

# Docker Stack Management (feature-flagged, undocumented for v1)
# DOCKER_MANAGEMENT_FEATURE_FLAG="true"
# GIT_REPOS_DIR="/data/repos"
# GIT_SERVER_TOKEN="<random-token-here>"  # Required for git clone/push authentication
```

- [ ] **Step 2: Verify Dockerfile has git installed in the runtime stage** (done in Task 9 Step 6)

Confirm the **final runtime stage** (not just deps/build) includes:
```dockerfile
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Run full typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add .env.example Dockerfile
git commit -m "chore: add git management env vars and git binary to Docker image"
```

---

## Chunk 10: Integration Test

### Task 15: End-to-end git workflow test

**Files:**
- Create: `src/lib/git/__tests__/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/lib/git/__tests__/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles, readFileFromRepo, listFilesInRepo, getLog, diffCommits } from '../repo';
import { parseManifest } from '../manifest';
import { identifyChangedStacks, buildDeployRequests } from '../post-receive';
import { saveAndCommitFile, updateManifest } from '../editor-operations';
import { buildFileTree } from '../git-server-functions';

describe('Git management integration', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-integration-'));
    repoPath = join(testDir, 'stacks.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should support full workflow: init -> add stack -> edit -> detect changes -> deploy request', async () => {
    // 1. Create initial manifest and stack
    const sha1 = await commitFiles(repoPath, {
      files: [
        {
          path: 'manifest.yaml',
          content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n',
        },
        {
          path: 'plex/docker-compose.yml',
          content: 'services:\n  plex:\n    image: plexinc/pms-docker:latest\n',
        },
      ],
      message: 'Initial setup',
      author: { name: 'jared', email: 'jared@example.com' },
    });

    // 2. Verify files are readable
    const manifest = await readFileFromRepo(repoPath, 'manifest.yaml');
    const parsed = parseManifest(manifest);
    expect(parsed.stacks.plex.host).toBe('homeserver');

    // 3. List files and build tree
    const files = await listFilesInRepo(repoPath);
    expect(files).toHaveLength(2);
    const tree = buildFileTree(files);
    expect(tree[0].type).toBe('directory'); // plex/
    expect(tree[1].type).toBe('file'); // manifest.yaml

    // 4. Edit compose file via UI
    const editResult = await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: 'services:\n  plex:\n    image: plexinc/pms-docker:1.40.0\n',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Update plex to 1.40.0',
    });

    // 5. Verify log
    const log = await getLog(repoPath, 10);
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('Update plex to 1.40.0');

    // 6. Diff and detect changes
    const changedFiles = await diffCommits(repoPath, sha1, editResult.commitSha);
    expect(changedFiles).toEqual(['plex/docker-compose.yml']);

    const changedStacks = identifyChangedStacks(changedFiles);
    expect(changedStacks).toEqual(['plex']);

    // 7. Build deploy requests
    const requests = await buildDeployRequests(repoPath, sha1, editResult.commitSha);
    expect(requests).toHaveLength(1);
    expect(requests[0].stack).toBe('plex');
    expect(requests[0].host).toBe('homeserver');
    expect(requests[0].autoApproved).toBe(true);
    expect(requests[0].action).toBe('deploy');

    // 8. Add a new stack via manifest update
    const manifestResult = await updateManifest(repoPath, {
      stackName: 'traefik',
      host: 'homeserver',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    const updatedManifest = await readFileFromRepo(repoPath, 'manifest.yaml');
    const updatedParsed = parseManifest(updatedManifest);
    expect(updatedParsed.stacks.traefik).toBeDefined();
    expect(updatedParsed.stacks.traefik.auto_deploy).toBe(false);

    // 9. Final log should have 3 commits
    const finalLog = await getLog(repoPath, 10);
    expect(finalLog).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test src/lib/git/__tests__/integration.test.ts`
Expected: All tests pass

- [ ] **Step 3: Run full typecheck and test suite**

Run: `bun run typecheck && bun test`
Expected: No errors, all tests pass, coverage thresholds met

- [ ] **Step 4: Commit**

```bash
git add src/lib/git/__tests__/integration.test.ts
git commit -m "test(git): add end-to-end integration test for git management workflow"
```

---

## Summary

### Files Created

| File | Purpose |
|------|---------|
| `src/lib/config/git-config.ts` | Git config from env vars with feature flag |
| `src/lib/config/__tests__/git-config.test.ts` | Config tests |
| `src/lib/git/manifest.ts` | Manifest YAML parser + zod validation |
| `src/lib/git/repo.ts` | Bare repo operations (init, commit, read, list, log, diff) |
| `src/lib/git/post-receive.ts` | Changed stack identification + deploy request builder |
| `src/lib/git/post-receive-handler.ts` | Post-receive orchestration (dispatch to pipeline) |
| `src/lib/git/git-http.ts` | Git HTTP path parser + request type utilities |
| `src/lib/git/git-server.ts` | Smart HTTP handlers (info/refs, upload-pack, receive-pack) |
| `src/lib/git/init-repo.ts` | Startup repo initialization with seed manifest |
| `src/lib/git/editor-operations.ts` | In-app file save/commit + manifest update |
| `src/lib/git/git-server-functions.ts` | File tree builder for UI |
| `src/routes/api/git.$.ts` | TanStack Router catch-all route for Git HTTP protocol |
| `src/lib/git/__tests__/*.test.ts` | Tests for all modules |

### Files Modified

| File | Change |
|------|--------|
| `package.json` | Added isomorphic-git, js-yaml, @types/js-yaml |
| `.env.example` | Added DOCKER_MANAGEMENT_FEATURE_FLAG, GIT_REPOS_DIR |
| `Dockerfile` | Added `git` binary installation |

### Architecture Decisions

- **Bare repos** via isomorphic-git for all read/write/commit operations -- no working tree needed
- **Git CLI** (`git-upload-pack`, `git-receive-pack`) via `Bun.spawn()` for smart HTTP protocol -- isomorphic-git does not implement the server side
- **Post-receive** captures HEAD before and after push, diffs trees, maps changed directories to manifest entries
- **Feature-flagged** -- all routes and initialization check `DOCKER_MANAGEMENT_FEATURE_FLAG`
- **Dynamic imports** in route handlers -- isomorphic-git, fs, and all git modules imported inside handler functions to avoid leaking into client bundle
- **Deploy pipeline dispatch** is a TODO stub in `post-receive-handler.ts` -- the deploy pipeline plan will implement the actual dispatch
