// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';

/**
 * No-op secret resolver. Returns an empty record.
 * Used when OpenBao is not configured. The OpenBao plan
 * provides a real implementation that replaces this.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolve(_stack: string, variables: string[]): Promise<Record<string, string>> {
    if (variables.length > 0) {
      throw new Error(
        `${variables.length} secret(s) requested (${variables.join(', ')}) ` +
        `but no secret backend is configured. Set up OpenBao or remove secret references from the compose file.`
      );
    }
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
  const regex = /\$\{([A-Za-z_]\w*)(?:[:?+-][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}
