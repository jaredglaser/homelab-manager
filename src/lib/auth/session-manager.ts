import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser } from '@/lib/auth/types';
import type { SessionRepository } from '@/lib/database/repositories/session-repository';
import type { MasterKeyring } from '@/lib/crypto/master-key';

export interface SessionManagerDeps {
  sessionRepo: SessionRepository;
  keyring: MasterKeyring;
  sessionTtlHours: number;
}

export class SessionManager {
  constructor(private readonly deps: SessionManagerDeps) {}

  async createSession(
    userId: number,
    idToken: string,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const hashedId = createHash('sha256').update(rawToken).digest('hex');

    // Persist only the id_token (used as id_token_hint for logout); dropping the
    // access/refresh tokens keeps a leaked session row from reaching the IdP APIs.
    const { encryptValue } = await import('@/lib/crypto/encrypted-value');
    const encryptedOidc = await encryptValue(JSON.stringify({ idToken }), this.deps.keyring);

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

  /** Returns the stored id_token for RP-initiated logout (id_token_hint), or null if unavailable. */
  async getIdToken(hashedId: string): Promise<string | null> {
    const result = await this.deps.sessionRepo.findById(hashedId);
    if (!result?.session.encryptedOidc) return null;
    try {
      const { decryptValue } = await import('@/lib/crypto/encrypted-value');
      const plain = await decryptValue(result.session.encryptedOidc, this.deps.keyring);
      const tokens = JSON.parse(plain) as { idToken?: string };
      return typeof tokens.idToken === 'string' ? tokens.idToken : null;
    } catch (err) {
      console.error('[SessionManager] Failed to decrypt id_token for logout hint:', err);
      return null;
    }
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
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { loadAuthConfig } = await import('@/lib/config/auth-config');
  const { SessionRepository } = await import('@/lib/database/repositories/session-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const keyring = await loadMasterKeyring();
  const authConfig = loadAuthConfig();

  cachedManager = new SessionManager({
    sessionRepo: new SessionRepository(dbClient.getPool()),
    keyring,
    sessionTtlHours: authConfig.sessionTtlHours,
  });
  return cachedManager;
}

export function resetSessionManagerState(): void {
  cachedManager = null;
}
