// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';

/**
 * No-op secret resolver. Returns an empty record.
 * Throws if any variables are requested, since callers should always
 * wire a real resolver (StackSecretsRepository) for stacks that need secrets.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolve(_stack: string, variables: string[]): Promise<Record<string, string>> {
    if (variables.length > 0) {
      throw new Error(
        `${variables.length} secret(s) requested (${variables.join(', ')}) ` +
        `but no secret backend is configured. Configure stack secrets or remove the references from the compose file.`
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
/**
 * Regex matching Docker Compose `${VAR}` references with optional modifiers
 * (`:-`, `-`, `:?`, `?`, `:+`, `+`). Shared across parse-variables and secret-resolver.
 */
export const COMPOSE_VARIABLE_REGEX = /\$\{([A-Za-z_]\w*)(?:[:?+-][^}]*)?\}/g;

export function extractVariableReferences(composeContent: string): string[] {
  const regex = new RegExp(COMPOSE_VARIABLE_REGEX.source, COMPOSE_VARIABLE_REGEX.flags);
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}
