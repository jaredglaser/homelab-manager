import '@tanstack/react-start/server-only';
import { createHash } from 'node:crypto';
import type { ApiTokenRepository } from '@/lib/database/repositories/api-token-repository';

export interface ApiTokenMatch {
  tokenId: number;
  scopes: string[];
}

export type ApiTokenAuthRepo = Pick<ApiTokenRepository, 'findByTokenHash'>;

export function hashApiToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function findMatchingApiToken(
  providedToken: string,
  repo: ApiTokenAuthRepo,
): Promise<ApiTokenMatch | null> {
  const match = await repo.findByTokenHash(hashApiToken(providedToken));
  if (!match) return null;
  return { tokenId: match.id, scopes: match.scopes };
}

export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}
