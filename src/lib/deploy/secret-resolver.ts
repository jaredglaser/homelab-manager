// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';
import { SECRET_DECRYPTION_FAILED_MESSAGE } from '@/lib/database/repositories/stack-secrets-repository';

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

/** The subset of StackSecretsRepository the resolver needs: a single-secret lookup by stack and variable name. */
export interface StackSecretsLookup {
  get(stackName: string, variableName: string): Promise<string | null>;
}

/** Resolves secrets in parallel via Promise.allSettled; classifies decryption failures (bad/rotated MASTER_KEY) separately from other errors (DB, etc.) since the fix differs. */
export class StackSecretsResolver implements SecretResolver {
  constructor(private readonly stackSecrets: StackSecretsLookup) {}

  async resolve(stack: string, variables: string[]): Promise<Record<string, string>> {
    if (variables.length === 0) return {};
    const results = await Promise.allSettled(
      variables.map(async (v) => [v, await this.stackSecrets.get(stack, v)] as const),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const decryptionFailures = rejected.filter(
      (r) => r.reason instanceof Error && r.reason.message === SECRET_DECRYPTION_FAILED_MESSAGE,
    );
    const otherFailures = rejected.filter((r) => !decryptionFailures.includes(r));

    if (otherFailures.length > 0) {
      throw otherFailures[0].reason instanceof Error
        ? otherFailures[0].reason
        : new Error(String(otherFailures[0].reason));
    }
    if (decryptionFailures.length > 0) {
      throw new Error(
        `Failed to decrypt ${decryptionFailures.length} secret(s) for stack "${stack}". Check that MASTER_KEY is correct.`,
      );
    }
    const entries = results
      .filter((r): r is PromiseFulfilledResult<readonly [string, string | null]> => r.status === 'fulfilled')
      .map((r) => r.value);
    const secrets: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (v !== null) secrets[k] = v;
    }
    return secrets;
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
