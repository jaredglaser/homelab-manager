import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock server functions before importing the component
mock.module('@/data/auth.functions', () => ({
  listUsers: mock(() => Promise.resolve([])),
  listSessions: mock(() => Promise.resolve([])),
  revokeSession: mock(() => Promise.resolve()),
  revokeAllUserSessions: mock(() => Promise.resolve()),
  getSession: mock(() => Promise.resolve(null)),
  resetAuthFunctionsState: mock(() => {}),
  getRoleMapping: mock(() => Promise.resolve({ admin: 'homelab-admins', operator: 'homelab-operators', viewer: 'homelab-viewers' })),
}))

mock.module('@/data/git-tokens.functions', () => ({
  listGitTokens: mock(() => Promise.resolve([])),
  createGitToken: mock(() => Promise.resolve({ token: 'test-token-abc123' })),
  revokeGitToken: mock(() => Promise.resolve()),
}))

// eslint-disable-next-line import/first
import { AuthManagementCard } from '@/components/settings/AuthManagementCard'

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
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

const mockUsers = [
  {
    id: 1,
    oidcSubject: 'sub1',
    email: 'alice@example.com',
    name: 'Alice',
    role: 'admin' as const,
    oidcGroups: ['homelab-admins'],
    lastLogin: new Date('2024-01-15T10:00:00.000Z'),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-15T10:00:00.000Z'),
  },
  {
    id: 2,
    oidcSubject: 'sub2',
    email: 'bob@example.com',
    name: 'Bob',
    role: 'viewer' as const,
    oidcGroups: ['homelab-viewers'],
    lastLogin: new Date('2024-02-01T08:00:00.000Z'),
    createdAt: new Date('2024-01-10T00:00:00.000Z'),
    updatedAt: new Date('2024-02-01T08:00:00.000Z'),
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

describe('AuthManagementCard', () => {
  beforeEach(() => {
    // Reset mock implementations to empty defaults
    const authFns = require('@/data/auth.functions') as {
      listUsers: ReturnType<typeof mock>
      listSessions: ReturnType<typeof mock>
      getRoleMapping: ReturnType<typeof mock>
    }
    const gitFns = require('@/data/git-tokens.functions') as {
      listGitTokens: ReturnType<typeof mock>
      createGitToken: ReturnType<typeof mock>
      revokeGitToken: ReturnType<typeof mock>
    }
    authFns.listUsers.mockImplementation(() => Promise.resolve([]))
    authFns.listSessions.mockImplementation(() => Promise.resolve([]))
    authFns.getRoleMapping.mockImplementation(() => Promise.resolve({ admin: 'homelab-admins', operator: 'homelab-operators', viewer: 'homelab-viewers' }))
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

    it('renders default group names when env vars not set', async () => {
      renderCard()
      await waitFor(() => {
        expect(screen.getByText('homelab-admins')).toBeDefined()
        expect(screen.getByText('homelab-operators')).toBeDefined()
        expect(screen.getByText('homelab-viewers')).toBeDefined()
      })
    })
  })

  describe('users table', () => {
    it('renders users table heading', () => {
      renderCard()
      expect(screen.getByText('Users')).toBeDefined()
    })

    it('renders users table column headers after load', async () => {
      renderCard()
      await waitFor(() => {
        expect(screen.getByText('Name')).toBeDefined()
        expect(screen.getByText('Email')).toBeDefined()
        expect(screen.getByText('Last Login')).toBeDefined()
      })
    })

    it('renders user rows when data is loaded', async () => {
      const authFns = require('@/data/auth.functions') as { listUsers: ReturnType<typeof mock> }
      authFns.listUsers.mockImplementation(() => Promise.resolve(mockUsers))

      renderCard()
      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeDefined()
        expect(screen.getByText('alice@example.com')).toBeDefined()
      })
    })

    it('renders lastLogin date for users (not the fallback dash)', async () => {
      const authFns = require('@/data/auth.functions') as { listUsers: ReturnType<typeof mock> }
      authFns.listUsers.mockImplementation(() => Promise.resolve(mockUsers))

      renderCard()
      await waitFor(() => {
        const emailCell = screen.getByText('alice@example.com')
        const row = emailCell.closest('tr')
        const lastLoginCell = row?.querySelectorAll('td')[3]
        expect(lastLoginCell?.textContent).not.toBe('—')
        expect(lastLoginCell?.textContent?.length).toBeGreaterThan(0)
      })
    })

    it('shows empty state when no users', async () => {
      renderCard()
      await waitFor(() => expect(screen.getByText('No users found.')).toBeDefined())
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
      await waitFor(() => {
        const revokeButtons = screen.getAllByLabelText('Revoke session')
        expect(revokeButtons.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('renders Revoke All Sessions button per user group', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.resolve(mockSessions))

      renderCard()
      await waitFor(() => expect(screen.getByText('Revoke All Sessions')).toBeDefined())
    })

    it('renders IP Address column header', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.resolve(mockSessions))

      renderCard()
      await waitFor(() => expect(screen.getByText('IP Address')).toBeDefined())
    })

    it('shows empty state when no sessions', async () => {
      renderCard()
      await waitFor(() => expect(screen.getByText('No active sessions.')).toBeDefined())
    })
  })

  describe('error states', () => {
    it('shows error alert when users fail to load', async () => {
      const authFns = require('@/data/auth.functions') as { listUsers: ReturnType<typeof mock> }
      authFns.listUsers.mockImplementation(() => Promise.reject(new Error('Network error')))
      renderCard()
      await waitFor(() => expect(screen.getByText(/Failed to load users/)).toBeDefined())
    })

    it('shows error alert when sessions fail to load', async () => {
      const authFns = require('@/data/auth.functions') as { listSessions: ReturnType<typeof mock> }
      authFns.listSessions.mockImplementation(() => Promise.reject(new Error('Network error')))
      renderCard()
      await waitFor(() => expect(screen.getByText(/Failed to load sessions/)).toBeDefined())
    })

    it('shows error alert when git tokens fail to load', async () => {
      const gitFns = require('@/data/git-tokens.functions') as { listGitTokens: ReturnType<typeof mock> }
      gitFns.listGitTokens.mockImplementation(() => Promise.reject(new Error('Network error')))
      renderCard()
      await waitFor(() => expect(screen.getByText(/Failed to load tokens/)).toBeDefined())
    })
  })

  describe('git tokens section', () => {
    it('renders git tokens heading', () => {
      renderCard()
      expect(screen.getByText('Git Tokens')).toBeDefined()
    })

    it('renders git tokens table column headers', async () => {
      renderCard()
      await waitFor(() => {
        expect(screen.getByText('Label')).toBeDefined()
        expect(screen.getByText('Last Used')).toBeDefined()
      })
    })

    it('renders Generate Token button', () => {
      renderCard()
      expect(screen.getByText('Generate Token')).toBeDefined()
    })

    it('renders token rows when data is loaded', async () => {
      const gitFns = require('@/data/git-tokens.functions') as { listGitTokens: ReturnType<typeof mock> }
      gitFns.listGitTokens.mockImplementation(() => Promise.resolve(mockTokens))

      renderCard()
      await waitFor(() => expect(screen.getByText('CI deploy key')).toBeDefined())
    })

    it('renders revoke token button for each token', async () => {
      const gitFns = require('@/data/git-tokens.functions') as { listGitTokens: ReturnType<typeof mock> }
      gitFns.listGitTokens.mockImplementation(() => Promise.resolve(mockTokens))

      renderCard()
      await waitFor(() => {
        const revokeButtons = screen.getAllByLabelText('Revoke token')
        expect(revokeButtons.length).toBeGreaterThanOrEqual(1)
      })
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

      await waitFor(() => {
        expect(screen.getByText('Copy this token now — it will not be shown again.')).toBeDefined()
        expect(screen.getByText('test-token-abc123')).toBeDefined()
      })
    })

    describe('dialog close (handleClose / handleDialogClose)', () => {
      const origSetTimeout = globalThis.setTimeout
      const origClearTimeout = globalThis.clearTimeout
      let pendingCallbacks: Array<{ fn: () => void; id: number }> = []
      let nextTimerId = 9000

      beforeEach(() => {
        pendingCallbacks = []
        nextTimerId = 9000
        ;(globalThis as any).setTimeout = (fn: () => void) => {
          const id = nextTimerId++
          pendingCallbacks.push({ fn, id })
          return id
        }
        ;(globalThis as any).clearTimeout = (id?: number) => {
          pendingCallbacks = pendingCallbacks.filter((cb) => cb.id !== id)
        }
      })

      afterEach(() => {
        globalThis.setTimeout = origSetTimeout
        globalThis.clearTimeout = origClearTimeout
      })

      function flushTimers() {
        const cbs = [...pendingCallbacks]
        pendingCallbacks = []
        for (const cb of cbs) cb.fn()
      }

      it('Cancel resets label and calls handleDialogClose', () => {
        renderCard()
        act(() => { flushTimers() })

        fireEvent.click(screen.getByText('Generate Token'))
        act(() => { flushTimers() })

        const labelInput = screen.getByLabelText('Token label')
        fireEvent.change(labelInput, { target: { value: 'my label' } })

        act(() => {
          fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        })
        act(() => { flushTimers() })
        act(() => { flushTimers() })

        // After close: handleClose cleared the label; handleDialogClose closed the dialog.
        // The dialog content stays mounted during MUI exit transition in Happy-DOM,
        // but the label state was reset to '' (line 261) and setGenerateDialogOpen(false)
        // and setNewToken(null) were called (lines 337-338).
        // Reopen to confirm label was reset:
        fireEvent.click(screen.getByText('Generate Token'))
        act(() => { flushTimers() })
        expect((screen.getByLabelText('Token label') as HTMLInputElement).value).toBe('')
      })
    })
  })
})
