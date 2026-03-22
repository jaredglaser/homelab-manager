import { createHash, randomBytes } from 'crypto';
import type { AuthUser, OidcTokens } from '@/lib/auth/types';
import type { SessionRepository } from '@/lib/database/repositories/session-repository';
import type { TransitClient } from '@/lib/clients/transit-client';

export interface SessionManagerDeps {
  sessionRepo: SessionRepository;
  transitClient: TransitClient;
  sessionTtlHours: number;
}

export class SessionManager {
  constructor(private readonly deps: SessionManagerDeps) {}

  async createSession(
    userId: number,
    tokens: OidcTokens,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const hashedId = createHash('sha256').update(rawToken).digest('hex');

    const encryptedOidc = await this.deps.transitClient.encrypt(
      'session-tokens',
      JSON.stringify(tokens),
    );

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.deps.sessionTtlHours);

    await this.deps.sessionRepo.create({
      id: hashedId,
      userId,
      encryptedOidc,
      ipAddress,
      userAgent,
      expiresAt,
    });

    return rawToken;
  }

  async validateSession(rawToken: string): Promise<AuthUser | null> {
    const hashedId = createHash('sha256').update(rawToken).digest('hex');
    const result = await this.deps.sessionRepo.findById(hashedId);
    return result?.user ?? null;
  }

  async revokeSession(hashedId: string): Promise<void> {
    await this.deps.sessionRepo.deleteById(hashedId);
  }

  async revokeAllUserSessions(userId: number): Promise<void> {
    await this.deps.sessionRepo.deleteByUserId(userId);
  }

  async cleanupExpired(): Promise<void> {
    await this.deps.sessionRepo.deleteExpired();
  }
}

let cachedManager: SessionManager | null = null;

export async function buildSessionManager(): Promise<SessionManager> {
  if (cachedManager) return cachedManager;

  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { TransitClient } = await import('@/lib/clients/transit-client');
  const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
  const { loadAuthConfig } = await import('@/lib/config/auth-config');
  const { SessionRepository } = await import('@/lib/database/repositories/session-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const baoConfig = loadOpenBaoConfig();
  const authConfig = loadAuthConfig();

  cachedManager = new SessionManager({
    sessionRepo: new SessionRepository(dbClient.getPool()),
    transitClient: new TransitClient(baoConfig),
    sessionTtlHours: authConfig.sessionTtlHours,
  });
  return cachedManager;
}

export function resetSessionManagerState(): void {
  cachedManager = null;
}
