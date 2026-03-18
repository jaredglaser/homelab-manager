import git from 'isomorphic-git';
import type { TreeEntry } from 'isomorphic-git';
import * as fs from 'fs';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoPath) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoLocks.set(repoPath, current);
  await previous;
  try {
    return await fn();
  } finally {
    release!();
  }
}

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
    await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Could not resolve') || message.includes('resolve ref') || message.includes('Could not find')) {
      // HEAD doesn't resolve to a commit yet (empty repo) — check for HEAD file
      return existsSync(`${repoPath}/HEAD`) && existsSync(`${repoPath}/objects`) && existsSync(`${repoPath}/refs`);
    }
    console.error('[Git] Unexpected error checking repo:', message);
    return false;
  }
}

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
  return withRepoLock(repoPath, async () => {
    const { files, message, author } = options;

    let existingFiles = new Map<string, string>();
    let parentCommit: string | undefined;
    try {
      parentCommit = await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    } catch {
      // No HEAD yet — first commit, existingFiles stays empty
    }

    if (parentCommit) {
      const { tree } = await git.readTree({ fs, gitdir: repoPath, oid: parentCommit });
      existingFiles = await readTreeRecursive(repoPath, tree, '');
    }

    for (const file of files) {
      existingFiles.set(file.path, file.content);
    }

    const treeOid = await buildTree(repoPath, existingFiles);

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

    await git.writeRef({
      fs,
      gitdir: repoPath,
      ref: 'refs/heads/main',
      value: commitOid,
      force: true,
    });

    writeFileSync(`${repoPath}/HEAD`, 'ref: refs/heads/main\n');

    return commitOid;
  });
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
  tree: TreeEntry[],
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
  tree: TreeEntry[],
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
      type: e.mode === '040000' ? ('tree' as const) : ('blob' as const),
    })),
  });
}

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
  tree: TreeEntry[],
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
