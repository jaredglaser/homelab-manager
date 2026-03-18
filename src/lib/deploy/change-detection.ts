import type { DeployRecord } from '@/lib/deploy/types';

/**
 * Compute a SHA-256 hex hash for content comparison.
 * Used for compose file and env content change detection.
 */
export function computeHash(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

export interface ChangeDetectionResult {
  changed: boolean;
  composeHash: string;
  envHash: string;
}

/**
 * Compare compose content and env content against the last successful deploy.
 * First deploy (null previousDeploy) always returns changed: true.
 */
export function detectChanges(
  composeContent: string,
  envContent: string,
  previousDeploy: DeployRecord | null,
): ChangeDetectionResult {
  const composeHash = computeHash(composeContent);
  const envHash = computeHash(envContent);

  if (previousDeploy === null) {
    return { changed: true, composeHash, envHash };
  }

  const changed =
    composeHash !== previousDeploy.composeHash ||
    envHash !== previousDeploy.envHash;

  return { changed, composeHash, envHash };
}
