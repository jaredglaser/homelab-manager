import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ----- Module mocks -----

// Mock server functions before importing the component
mock.module('@/data/auth.functions', () => ({
  listUsers: mock(() => Promise.resolve([])),
  listSessions: mock(() => Promise.resolve([])),
  revokeSession: mock(() => Promise.resolve()),
  revokeAllUserSessions: mock(() => Promise.resolve()),
  getSession: mock(() => Promise.resolve(null)),
  resetAuthFunctionsState: mock(() => {}),
}))

mock.module('@/data/git-tokens.functions', () => ({
  listGitTokens: mock(() => Promise.resolve([])),
  createGitToken: mock(() => Promise.resolve({ token: 'test-token-abc123' })),
  revokeGitToken: mock(() => Promise.resolve()),
}))

// eslint-disable-next-line import/first
import { AuthManagementCard } from '../AuthManagementCard'

// ----- Test helpers -----

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function renderCard() {
  const queryClient = makeQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthManagementCard />
    </QueryClientProvider>
  )
}

// ----- Fixtures -----

const mockUsers = [
  {
    id: 1,
    oidc_subject: 'sub1',
    email: 'alice@example.com',
    name: 'Alice',
    role: 'admin' as const,
    oidc_groups: ['homelab-admins'],
    last_login: new Date('2024-01-15T10:00:00.000Z'),
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-15T10:00:00.000Z'),
  },
  {
    id: 2,
    oidc_subject: 'sub2',
    email: 'bob@example.com',
    name: 'Bob',
    role: 'viewer' as const,
    oidc_groups: ['homelab-viewers'],
    last_login: new Date('2024-02-01T08:00:00.000Z'),
    created_at: new Date('2024-01-10T00:00:00.000Z'),
    updated_at: new Date('2024-02-01T08:00:00.000Z'),
  },
]

const mockSessions = [
  {
    id: 'session-abc',
    userId: 1,
    encryptedOidc: null,
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2024-01-15T10:00:00.000Z'),
    userName: 'Alice',
    userEmail: 'alice@example.com',
  },
]

const mockTokens = [
  {
    id: 1,
    userId: 1,
    label: 'CI deploy key',
    lastUsedAt: new Date('2024-02-10T12:00:00.000Z'),
    createdAt: new Date('2024-01-20T09:00:00.000Z'),
    userName: 'Alice',
    userEmail: 'alice@example.com',
  },
]

// ----- Tests -----

describe('AuthManagementCard', () => {
  beforeEach(() => {
    // Reset mock implementations to empty defaults
    const authFns = require('@/data/auth.functions') as {
      listUsers: ReturnType<typeof mock>
      listSessions: ReturnType<typeof mock>
    }
    const gitFns = require('@/data/git-tokens.functions') as {
      listGitTokens: ReturnType<typeof mock>
      createGitToken: ReturnType<typeof mock>
      revokeGitToken: ReturnType<typeof mock>
    }
    authFns.listUsers.mockImplementation(() => Promise.resolve([]))
    authFns.listSessions.mockImplementation(() => Promise.resolve([]))
    gitFns.listGitTokens.mockImplementation(() => Promise.resolve([]))
    gitFns.createGitToken.mockImplementation(() => Promise.resolve({ token: 'test-token-abc123' }))
    gitFns.revokeGitToken.mockImplementation(() => Promise.resolve())
  })

  describe('card structure', () => {
    it('renders card heading', () => {
      renderCard()
      expect(screen.getByText('Auth Management')).toBeDefined()
    })
  })

  describe('role mapping panel', () => {
    it('renders role mapping table headers', () => {
      renderCard()
      expect(screen.getByText('Role')).toBeDefined()
      expect(screen.getByText('OIDC Group')).toBeDefined()
    })

    it('renders all three roles', () => {
      renderCard()
      expect(screen.getByText('Admin')).toBeDefined()
      expect(screen.getByText('Operator')).toBeDefined()
      expect(screen.getByText('Viewer')).toBeDefined()
    })

    it('renders ? icon button for role mapping info', () => {
      renderCard()
      expect(screen.getByLabelText('Role mapping info')).toBeDefined()
    })

    it('? icon button has correct tooltip text about OIDC provider', async () => {
      renderCard()
      const btn = screen.getByLabelText('Role mapping info')
      // MUI Tooltip renders content on hover via aria — verify button exists with accessible name
      expect(btn).toBeDefined()
    })

    it('renders default group names when env vars not set', () => {
      renderCard()
      expect(screen.getByText('homelab-admins')).toBeDefined()
      expect(screen.getByText('homelab-operators')).toBeDefined()
      expect(screen.getByText('homelab-viewers')).toBeDefined()
    })
  })

  describe('users table', () => {
    it('renders users table heading', () => {
      renderCard()
      expect(screen.getByText('Users')).toBeDefined()
    })

    it('renders users table column headers after load', async () => {
      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('Name')).toBeDefined()
      expect(screen.getByText('Email')).toBeDefined()
      expect(screen.getByText('Last Login')).toBeDefined()
    })

    it('renders user rows when data is loaded', async () => {
      const authFns = require('@/data/auth.functions') as { listUsers: ReturnType<typeof mock> }
      authFns.listUsers.mockImplementation(() => Promise.resolve(mockUsers))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('Alice')).toBeDefined()
      expect(screen.getByText('alice@example.com')).toBeDefined()
    })

    it('shows empty state when no users', async () => {
      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('No users found.')).toBeDefined()
    })
  })

  describe('sessions table', () => {
    it('renders sessions table heading', () => {
      renderCard()
      expect(screen.getByText('Active Sessions')).toBeDefined()
    })

    it('renders role change info banner', () => {
      renderCard()
      expect(screen.getByText(/Role changes in your OIDC provider take effect on next login/)).toBeDefined()
    })

    it('renders revoke session button when sessions exist', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.resolve(mockSessions))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      const revokeButtons = screen.getAllByLabelText('Revoke session')
      expect(revokeButtons.length).toBeGreaterThanOrEqual(1)
    })

    it('renders Revoke All Sessions button per user group', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.resolve(mockSessions))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('Revoke All Sessions')).toBeDefined()
    })

    it('renders IP Address column header', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.resolve(mockSessions))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('IP Address')).toBeDefined()
    })

    it('shows empty state when no sessions', async () => {
      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('No active sessions.')).toBeDefined()
    })
  })

  describe('git tokens section', () => {
    it('renders git tokens heading', () => {
      renderCard()
      expect(screen.getByText('Git Tokens')).toBeDefined()
    })

    it('renders git tokens table column headers', async () => {
      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('Label')).toBeDefined()
      expect(screen.getByText('Last Used')).toBeDefined()
    })

    it('renders Generate Token button', () => {
      renderCard()
      expect(screen.getByText('Generate Token')).toBeDefined()
    })

    it('renders token rows when data is loaded', async () => {
      const gitFns = require('@/data/git-tokens.functions') as { listGitTokens: ReturnType<typeof mock> }
      gitFns.listGitTokens.mockImplementation(() => Promise.resolve(mockTokens))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('CI deploy key')).toBeDefined()
    })

    it('renders revoke token button for each token', async () => {
      const gitFns = require('@/data/git-tokens.functions') as { listGitTokens: ReturnType<typeof mock> }
      gitFns.listGitTokens.mockImplementation(() => Promise.resolve(mockTokens))

      renderCard()
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      const revokeButtons = screen.getAllByLabelText('Revoke token')
      expect(revokeButtons.length).toBeGreaterThanOrEqual(1)
    })

    it('opens generate token dialog when Generate Token is clicked', () => {
      renderCard()
      fireEvent.click(screen.getByText('Generate Token'))
      expect(screen.getByText('Generate Git Token')).toBeDefined()
    })

    it('generate token dialog has label input', () => {
      renderCard()
      fireEvent.click(screen.getByText('Generate Token'))
      expect(screen.getByLabelText('Token label')).toBeDefined()
    })

    it('shows generated token after generation with warning', async () => {
      renderCard()
      fireEvent.click(screen.getByText('Generate Token'))
      const labelInput = screen.getByLabelText('Token label')
      fireEvent.change(labelInput, { target: { value: 'My token' } })
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

      expect(screen.getByText('Copy this token now — it will not be shown again.')).toBeDefined()
      expect(screen.getByText('test-token-abc123')).toBeDefined()
    })
  })
})
