// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';

/**
 * No-op secret resolver. Returns an empty record.
 * Used when OpenBao is not configured. The OpenBao plan
 * provides a real implementation that replaces this.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolve(_stack: string, _variables: string[]): Promise<Record<string, string>> {
    return {};
  }
}

/**
 * Extract variable references from Docker Compose content.
 * Supports variable substitution syntax, including default values.
 * Returns deduplicated variable names.
 */
export function extractVariableReferences(composeContent: string): string[] {
  const regex = /\$\{([A-Z_][A-Z0-9_]*)(?:[:?+-][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}
