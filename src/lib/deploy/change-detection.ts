import { createHash } from 'node:crypto';
import type { DeployRecord } from '@/lib/deploy/types';

/**
 * Compute a SHA-256 hex hash for content comparison.
 * Uses node:crypto (works in both Bun and Vite SSR contexts).
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
