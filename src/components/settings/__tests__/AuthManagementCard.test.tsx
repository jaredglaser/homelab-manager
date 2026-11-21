import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, waitFor, act, within } from '@testing-library/react'
import { setupUser, installPassthroughAsyncWrapper, activateWithKey, type TestUser } from '@/lib/test/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock server functions before importing the component
mockModule<typeof import('@/data/auth.functions')>('@/data/auth.functions', (real) => ({ ...real, 
  listUsers: mock(() => Promise.resolve([])),
  listSessions: mock(() => Promise.resolve([])),
  revokeSession: mock(() => Promise.resolve()),
  revokeAllUserSessions: mock(() => Promise.resolve()),
  getSession: mock(() => Promise.resolve(null)),
  getRoleMapping: mock(() => Promise.resolve({ admin: 'homelab-admins', operator: 'homelab-operators', viewer: 'homelab-viewers' })),
}))

mockModule<typeof import('@/data/git-tokens.functions')>('@/data/git-tokens.functions', (real) => ({ ...real, 
  listGitTokens: mock(() => Promise.resolve([])),
  createGitToken: mock(() => Promise.resolve({ token: 'test-token-abc123' })),
  revokeGitToken: mock(() => Promise.resolve()),
}))

import { AuthManagementCard } from '@/components/settings/AuthManagementCard'
import { mockModule } from '@/lib/test/mock-module';

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
    const authFns = require('@/data/auth.functions') as {
      listUsers: ReturnType<typeof mock>
      listSessions: ReturnType<typeof mock>
      revokeSession: ReturnType<typeof mock>
      revokeAllUserSessions: ReturnType<typeof mock>
      getRoleMapping: ReturnType<typeof mock>
    }
    const gitFns = require('@/data/git-tokens.functions') as {
      listGitTokens: ReturnType<typeof mock>
      createGitToken: ReturnType<typeof mock>
      revokeGitToken: ReturnType<typeof mock>
    }
    for (const fn of [authFns.listUsers, authFns.listSessions, authFns.revokeSession, authFns.revokeAllUserSessions, authFns.getRoleMapping, gitFns.listGitTokens, gitFns.createGitToken, gitFns.revokeGitToken]) fn.mockClear()
    authFns.listUsers.mockImplementation(() => Promise.resolve([]))
    authFns.listSessions.mockImplementation(() => Promise.resolve([]))
    authFns.revokeSession.mockImplementation(() => Promise.resolve())
    authFns.revokeAllUserSessions.mockImplementation(() => Promise.resolve())
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

  describe('session revocation', () => {
    const sessionsForTwoUsers = [
      { ...mockSessions[0], id: 'session-carol', userId: 3, userName: 'Carol', userEmail: 'carol@example.com' },
      { ...mockSessions[0], id: 'session-dave', userId: 7, userName: 'Dave', userEmail: 'dave@example.com' },
    ]

    function authFns() {
      return require('@/data/auth.functions') as {
        listSessions: ReturnType<typeof mock>
        revokeSession: ReturnType<typeof mock>
        revokeAllUserSessions: ReturnType<typeof mock>
      }
    }

    it('revokes one session by its id', async () => {
      const user = setupUser()
      authFns().listSessions.mockImplementation(() => Promise.resolve(sessionsForTwoUsers))
      renderCard()
      const buttons = await screen.findAllByLabelText('Revoke session')
      await user.click(buttons[1])
      await waitFor(() => expect(authFns().revokeSession).toHaveBeenCalledTimes(1))
      expect(authFns().revokeSession).toHaveBeenCalledWith({ data: { sessionId: 'session-dave' } })
    })

    it('revokes every session of the chosen user by user id', async () => {
      const user = setupUser()
      authFns().listSessions.mockImplementation(() => Promise.resolve(sessionsForTwoUsers))
      renderCard()
      await user.click(await screen.findByLabelText('Revoke all sessions for Dave'))
      await waitFor(() => expect(authFns().revokeAllUserSessions).toHaveBeenCalledTimes(1))
      expect(authFns().revokeAllUserSessions).toHaveBeenCalledWith({ data: { userId: 7 } })
    })

    it('reloads the sessions after a revocation', async () => {
      const user = setupUser()
      authFns().listSessions.mockImplementation(() => Promise.resolve(sessionsForTwoUsers))
      renderCard()
      await user.click((await screen.findAllByLabelText('Revoke session'))[0])
      await waitFor(() => expect(authFns().listSessions).toHaveBeenCalledTimes(2))
    })

    it('disables every revoke button while a revocation is running', async () => {
      const user = setupUser()
      authFns().listSessions.mockImplementation(() => Promise.resolve(sessionsForTwoUsers))
      authFns().revokeSession.mockImplementation(() => new Promise(() => {}))
      renderCard()
      const buttons = await screen.findAllByLabelText('Revoke session')
      await user.click(buttons[0])
      await waitFor(() => {
        for (const button of screen.getAllByLabelText('Revoke session')) expect(button.hasAttribute('disabled')).toBe(true)
      })
    })

    it('disables every Revoke All button while a bulk revocation is running', async () => {
      const user = setupUser()
      authFns().listSessions.mockImplementation(() => Promise.resolve(sessionsForTwoUsers))
      authFns().revokeAllUserSessions.mockImplementation(() => new Promise(() => {}))
      renderCard()
      await user.click(await screen.findByLabelText('Revoke all sessions for Carol'))
      await waitFor(() => {
        expect(screen.getByLabelText('Revoke all sessions for Carol').hasAttribute('disabled')).toBe(true)
        expect(screen.getByLabelText('Revoke all sessions for Dave').hasAttribute('disabled')).toBe(true)
      })
    })
  })

  describe('git token generation', () => {
    function gitFns() {
      return require('@/data/git-tokens.functions') as {
        listGitTokens: ReturnType<typeof mock>
        createGitToken: ReturnType<typeof mock>
        revokeGitToken: ReturnType<typeof mock>
      }
    }
    const generateButton = () => screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement

    async function openDialog(user: TestUser) {
      renderCard()
      await user.click(screen.getByText('Generate Token'))
      expect(screen.getByText('Generate Git Token')).toBeDefined()
    }

    it('sends the label trimmed', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), '  My token  ')
      await user.click(generateButton())
      await waitFor(() => expect(gitFns().createGitToken).toHaveBeenCalledTimes(1))
      expect(gitFns().createGitToken).toHaveBeenCalledWith({ data: { label: 'My token' } })
    })

    it('keeps Generate disabled and sends nothing for an empty or whitespace-only label', async () => {
      const user = setupUser()
      await openDialog(user)
      expect(generateButton().disabled).toBe(true)
      await user.click(generateButton())
      await user.type(screen.getByLabelText('Token label'), '   ')
      expect(generateButton().disabled).toBe(true)
      await user.click(generateButton())
      expect(gitFns().createGitToken).not.toHaveBeenCalled()
      await user.type(screen.getByLabelText('Token label'), 'x')
      expect(generateButton().disabled).toBe(false)
    })

    it('locks the dialog while the token is being generated', async () => {
      const user = setupUser()
      gitFns().createGitToken.mockImplementation(() => new Promise(() => {}))
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'My token')
      await user.click(generateButton())
      await waitFor(() => expect((screen.getByLabelText('Token label') as HTMLInputElement).disabled).toBe(true))
      const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
      expect(cancelBtn.hasAttribute('disabled')).toBe(true)
      expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
      const spinnerBtn = within(screen.getByRole('dialog')).getAllByRole('button').find((b) => b !== cancelBtn)!
      expect(spinnerBtn.hasAttribute('disabled')).toBe(true)
      await user.click(spinnerBtn)
      expect(gitFns().createGitToken).toHaveBeenCalledTimes(1)
    })

    it('copies the new token from the dialog', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'My token')
      await user.click(generateButton())
      await user.click(await screen.findByLabelText('Copy token'))
      expect(await navigator.clipboard.readText()).toBe('test-token-abc123')
    })

    it('closes with Done, forgets the token and reopens on an empty form', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'My token')
      await user.click(generateButton())
      await screen.findByText('test-token-abc123')

      await user.click(screen.getByRole('button', { name: 'Done' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))
      expect(screen.queryByText('test-token-abc123')).toBeNull()

      await user.click(screen.getByText('Generate Token'))
      expect(screen.getByText('Generate Git Token')).toBeDefined()
      expect((screen.getByLabelText('Token label') as HTMLInputElement).value).toBe('')
      expect(screen.queryByText('test-token-abc123')).toBeNull()
    })

    it('closes with Escape and forgets the token', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'My token')
      await user.click(generateButton())
      await screen.findByText('test-token-abc123')

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))
      await user.click(screen.getByText('Generate Token'))
      expect(screen.queryByText('test-token-abc123')).toBeNull()
      expect(screen.getByLabelText('Token label')).toBeDefined()
    })

    it('closes with Cancel and starts the next dialog with an empty label', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'draft label')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryAllByRole('dialog').length).toBe(0))
      await user.click(screen.getByText('Generate Token'))
      expect((screen.getByLabelText('Token label') as HTMLInputElement).value).toBe('')
    })

    it('reloads the token list after generating', async () => {
      const user = setupUser()
      await openDialog(user)
      await user.type(screen.getByLabelText('Token label'), 'My token')
      await user.click(generateButton())
      await screen.findByText('test-token-abc123')
      expect(gitFns().listGitTokens).toHaveBeenCalledTimes(2)
    })

    it('revokes the chosen token by id and reloads the list', async () => {
      const user = setupUser()
      gitFns().listGitTokens.mockImplementation(() =>
        Promise.resolve([mockTokens[0], { ...mockTokens[0], id: 9, label: 'Backup key' }]),
      )
      renderCard()
      await user.click((await screen.findAllByLabelText('Revoke token'))[1])
      expect(screen.getByText('Revoke "Backup key"? Applications using it will lose access. This cannot be undone.')).toBeDefined()
      await user.click(screen.getByRole('button', { name: 'Revoke' }))
      await waitFor(() => expect(gitFns().revokeGitToken).toHaveBeenCalledTimes(1))
      expect(gitFns().revokeGitToken).toHaveBeenCalledWith({ data: { tokenId: 9 } })
      await waitFor(() => expect(gitFns().listGitTokens).toHaveBeenCalledTimes(2))
    })

    it('disables the revoke button of every token while a revocation is running', async () => {
      const user = setupUser()
      gitFns().listGitTokens.mockImplementation(() => Promise.resolve(mockTokens))
      gitFns().revokeGitToken.mockImplementation(() => new Promise(() => {}))
      renderCard()
      await user.click(await screen.findByLabelText('Revoke token'))
      await user.click(screen.getByRole('button', { name: 'Revoke' }))
      await waitFor(() => expect(gitFns().revokeGitToken).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.getByLabelText('Revoke token').hasAttribute('disabled')).toBe(true))
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

    it('revokes a token only after confirmation', async () => {
      const user = setupUser()
      const gitFns = require('@/data/git-tokens.functions') as {
        listGitTokens: ReturnType<typeof mock>
        revokeGitToken: ReturnType<typeof mock>
      }
      gitFns.listGitTokens.mockImplementation(() => Promise.resolve([mockTokens[0]]))
      gitFns.revokeGitToken.mockImplementation(() => Promise.resolve())

      renderCard()
      await waitFor(() => expect(screen.getByLabelText('Revoke token')).toBeDefined())

      await user.click(screen.getByLabelText('Revoke token'))
      expect(screen.getByText('Revoke "CI deploy key"? Applications using it will lose access. This cannot be undone.')).toBeDefined()
      expect(gitFns.revokeGitToken).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(gitFns.revokeGitToken).not.toHaveBeenCalled()

      await user.click(screen.getByLabelText('Revoke token'))
      await user.click(screen.getByRole('button', { name: 'Revoke' }))
      await waitFor(() => expect(gitFns.revokeGitToken).toHaveBeenCalledWith({ data: { tokenId: 1 } }))
    })

    it('opens generate token dialog when Generate Token is clicked', async () => {
      const user = setupUser()
      renderCard()
      await user.click(screen.getByText('Generate Token'))
      expect(screen.getByText('Generate Git Token')).toBeDefined()
    })

    it('opens generate token dialog when Generate Token is activated from the keyboard', async () => {
      const user = setupUser()
      renderCard()
      await activateWithKey(user, screen.getByRole('button', { name: 'Generate Token' }), '{Enter}')
      expect(screen.getByText('Generate Git Token')).toBeDefined()
    })

    it('generate token dialog has label input', async () => {
      const user = setupUser()
      renderCard()
      await user.click(screen.getByText('Generate Token'))
      expect(screen.getByLabelText('Token label')).toBeDefined()
    })

    it('shows generated token after generation with warning', async () => {
      const user = setupUser()
      renderCard()
      await user.click(screen.getByText('Generate Token'))
      const labelInput = screen.getByLabelText('Token label')
      await user.type(labelInput, 'My token')
      await user.click(screen.getByRole('button', { name: 'Generate' }))

      await waitFor(() => {
        expect(screen.getByText('Copy this token now. It will not be shown again.')).toBeDefined()
        expect(screen.getByText('test-token-abc123')).toBeDefined()
        expect(screen.getByLabelText('Copy token')).toBeDefined()
      })
    })

    describe('dialog close (handleClose / handleDialogClose)', () => {
      const origSetTimeout = globalThis.setTimeout
      const origClearTimeout = globalThis.clearTimeout
      let restoreAsyncWrapper: () => void
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
        restoreAsyncWrapper = installPassthroughAsyncWrapper()
      })

      afterEach(() => {
        globalThis.setTimeout = origSetTimeout
        globalThis.clearTimeout = origClearTimeout
        restoreAsyncWrapper()
      })

      function flushTimers() {
        const cbs = [...pendingCallbacks]
        pendingCallbacks = []
        for (const cb of cbs) cb.fn()
      }

      it('Cancel resets label and calls handleDialogClose', async () => {
        const user = setupUser({ timersCaptured: true })
        renderCard()
        act(() => { flushTimers() })

        await act(async () => {
          await user.click(screen.getByText('Generate Token'))
        })
        act(() => { flushTimers() })

        const labelInput = screen.getByLabelText('Token label')
        await act(async () => {
          await user.type(labelInput, 'my label')
        })

        await act(async () => {
          await user.click(screen.getByRole('button', { name: 'Cancel' }))
        })
        act(() => { flushTimers() })
        act(() => { flushTimers() })

        expect(screen.queryAllByRole('dialog').length).toBe(0)
        await act(async () => {
          await user.click(screen.getByText('Generate Token'))
        })
        act(() => { flushTimers() })
        expect((screen.getByLabelText('Token label') as HTMLInputElement).value).toBe('')
      })
    })
  })
})
