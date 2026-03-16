// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';

/**
 * No-op secret resolver. Returns an empty record.
 * Used when OpenBao is not configured. The OpenBao plan
 * provides a real implementation that replaces this.
 */
export class NoOpSecretResolver implements SecretResolver {
  /** Workaround: explicit constructor so Bun counts it in function coverage (oven-sh/bun#7025) */
  constructor() {}
  async resolve(_stack: string, _variables: string[]): Promise<Record<string, string>> {
    return {};
  }
}

/**
 * Extract variable references from Docker Compose content.
 * Matches `${VAR_NAME}` and `${VAR_NAME:-default}` (with `:`, `?`, `+`, `-` expansions).
 * Variable names must start with a letter or underscore, followed by alphanumerics/underscores.
 * Both upper- and lowercase identifiers are supported (e.g. `${db_name}`, `${API_TOKEN}`).
 * Returns deduplicated variable names.
 */
export function extractVariableReferences(composeContent: string): string[] {
  const regex = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?+-][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}
