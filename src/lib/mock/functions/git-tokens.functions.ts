/**
 * Mock git-token server functions for demo / e2e mode. The real functions read
 * and write the `git_tokens` table; here they keep an in-memory list and mutate
 * it on create/revoke so the settings page works without a database. Field shapes
 * mirror the real `GitTokenWithUser` DTO (`label`, `Date` timestamps).
 */
import { z } from 'zod';


// Single demo user the tokens belong to; mirrors the user join on the real
// `GitTokenWithUser` DTO without standing up an auth backend.
const DEMO_USER = { id: 1, userName: 'testuser', userEmail: 'testuser@test.com' } as const;

export interface MockGitToken {
  id: number;
  userId: number;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  userName: string | null;
  userEmail: string;
}

// Mutable so create/revoke persist for the session, matching how the real
// endpoints behave when the list is refetched after a mutation.
let mockGitTokens: MockGitToken[] = [
  {
    id: 1,
    userId: DEMO_USER.id,
    label: 'ci-deploy',
    createdAt: new Date('2026-03-01T08:00:00Z'),
    lastUsedAt: new Date('2026-06-10T12:30:00Z'),
    userName: DEMO_USER.userName,
    userEmail: DEMO_USER.userEmail,
  },
];
let nextTokenId = mockGitTokens.length + 1;

export async function listGitTokens(): Promise<MockGitToken[]> {
  return [...mockGitTokens];
}

// Mirrors the real endpoint's `inputValidator` so a rejected label surfaces the same ZodError.
const createGitTokenInput = z.object({ label: z.string().min(1).max(100) });

export async function createGitToken(opts?: {
  data?: { label?: string };
}): Promise<{ token: string }> {
  const { label } = createGitTokenInput.parse({ label: opts?.data?.label?.trim() });
  mockGitTokens = [
    {
      id: nextTokenId++,
      userId: DEMO_USER.id,
      label,
      createdAt: new Date(),
      lastUsedAt: null,
      userName: DEMO_USER.userName,
      userEmail: DEMO_USER.userEmail,
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
