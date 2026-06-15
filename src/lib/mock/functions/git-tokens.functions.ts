/**
 * Mock git-token server functions for demo / e2e mode. The real functions read
 * and write the `git_tokens` table; here they return static, side-effect-free
 * data so the settings page renders without a database.
 */

export interface MockGitToken {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// Mutable so create/revoke persist for the session, matching how the real
// endpoints behave when the list is refetched after a mutation.
let mockGitTokens: MockGitToken[] = [
  {
    id: 1,
    name: 'ci-deploy',
    createdAt: '2026-03-01T08:00:00Z',
    lastUsedAt: '2026-06-10T12:30:00Z',
  },
];
let nextTokenId = mockGitTokens.length + 1;

export async function listGitTokens(): Promise<MockGitToken[]> {
  return [...mockGitTokens];
}

export async function createGitToken(opts?: {
  data?: { label?: string };
}): Promise<{ token: string }> {
  mockGitTokens = [
    {
      id: nextTokenId++,
      name: opts?.data?.label ?? 'new-token',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    },
    ...mockGitTokens,
  ];
  return { token: `demo_${Math.random().toString(36).slice(2, 18)}` };
}

export async function revokeGitToken(opts?: {
  data?: { tokenId?: number };
}): Promise<void> {
  const tokenId = opts?.data?.tokenId;
  if (typeof tokenId === 'number') {
    mockGitTokens = mockGitTokens.filter((token) => token.id !== tokenId);
  }
}
