/**
 * Owns the stack git-repo layout: where a stack's compose file lives, what the
 * manifest is called, which files belong to a stack, how the manifest is
 * serialized, and the single implementation of "remove a stack from the
 * manifest and delete its files". A layout change (renaming the compose file,
 * moving to nested dirs) should only ever require editing this file.
 */
import yaml from 'js-yaml';
import type { CommitCallback } from '@/lib/git/repo';
import { parseManifest, type StackManifest } from '@/lib/git/manifest';

/** Manifest filename at the repo root. */
export const MANIFEST = 'manifest.yaml';

const COMPOSE_FILENAME = 'docker-compose.yml';

const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

/** Path to a stack's compose file, relative to the repo root. */
export function composePath(stackName: string): string {
  return `${stackName}/${COMPOSE_FILENAME}`;
}

/** Directory prefix (with trailing slash) that contains all of a stack's files. */
function stackDirPrefix(stackName: string): string {
  return `${stackName}/`;
}

/** Root of the drift-recovery archive. Leading dot keeps it out of the stack namespace: stack names cannot contain a dot, so `identifyChangedStacks` never matches it against the manifest and a push carrying an archive never triggers a deploy. */
export const DRIFT_RECOVERY_DIR = '.drift-recovery';

/**
 * Path for an archived copy of a host's compose file, taken before a drift
 * resolution destroys it. Colons and dots in the timestamp become hyphens so the
 * path stays checkout-safe on every platform.
 */
export function driftRecoveryPath(host: string, stackName: string, capturedAt: string): string {
  const safeHost = host.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const safeTimestamp = capturedAt.replace(/[:.]/g, '-');
  return `${DRIFT_RECOVERY_DIR}/${safeHost}/${stackName}/${safeTimestamp}-docker-compose.yml`;
}

/** Filter a set of repo paths down to the ones that belong to a stack, for deletion. */
export function stackFiles(existingPaths: Iterable<string>, stackName: string): string[] {
  const prefix = stackDirPrefix(stackName);
  return Array.from(existingPaths).filter((path) => path.startsWith(prefix));
}

/**
 * The one yaml.dump call for manifest serialization. Sorted keys keep the diff
 * of a single-stack change to a single line instead of reordering the whole file.
 */
export function serializeManifest(manifest: StackManifest): string {
  return yaml.dump(manifest, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
  });
}

/**
 * Build the commitFiles plan that removes a stack from the manifest and deletes
 * its files. Returns a {@link CommitCallback}, ready to pass to `commitFiles`.
 *
 * Idempotent: if the stack is already absent from the manifest, only lingering
 * files (if any) are swept, so callers can retry or race safely. This is what
 * lets the orphaned-manifest-delete sweep in startup-recovery.ts call it
 * unconditionally for stacks it merely suspects were left behind.
 *
 * Used by both the synchronous "unmanage" delete path (stack-service.ts, via
 * createStackRepoWriter) and the async teardown-then-remove path
 * (stack-repo-writer.ts's StackRepoWriter port, consumed by DeployPipeline and
 * by the startup-recovery orphan sweep).
 */
export function removeStackFromManifest(stackName: string): CommitCallback {
  return (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST);
    if (manifestContent === undefined) {
      throw new Error(`${MANIFEST} not found in repo`);
    }
    const manifest = parseManifest(manifestContent);

    if (manifest.stacks[stackName]) {
      delete manifest.stacks[stackName];
    }

    return {
      files: [{ path: MANIFEST, content: serializeManifest(manifest) }],
      filesToDelete: stackFiles(existingFiles.keys(), stackName),
      message: `Remove stack: ${stackName}`,
      author: SYSTEM_AUTHOR,
    };
  };
}
