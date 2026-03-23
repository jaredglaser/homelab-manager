import { useState } from 'react'
import {
  Card,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Alert,
  CircularProgress,
} from '@mui/material'
import { HelpCircle, Trash2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listUsers, listSessions, revokeSession, revokeAllUserSessions } from '@/data/auth.functions'
import { listGitTokens, createGitToken, revokeGitToken } from '@/data/git-tokens.functions'

// ----- Role Mapping Panel -----

/**
 * Reads the role-to-OIDC-group mappings from Vite env vars.
 * These are set at build time via VITE_OIDC_ROLE_ADMIN, VITE_OIDC_ROLE_OPERATOR, VITE_OIDC_ROLE_VIEWER.
 * Falls back to the server-side defaults if not set.
 */
function RoleMappingPanel() {
  const roleMappings: { role: string; group: string }[] = [
    { role: 'Admin', group: import.meta.env.VITE_OIDC_ROLE_ADMIN ?? 'homelab-admins' },
    { role: 'Operator', group: import.meta.env.VITE_OIDC_ROLE_OPERATOR ?? 'homelab-operators' },
    { role: 'Viewer', group: import.meta.env.VITE_OIDC_ROLE_VIEWER ?? 'homelab-viewers' },
  ]

  const tooltipContent = (
    <div className="flex flex-col gap-1 max-w-xs text-sm">
      <span>Roles are managed in your OIDC provider.</span>
      <span>Configure groups in your provider and assign users to them.</span>
      {/* TODO: Link to documentation with PocketID setup screenshots */}
      <span>Role changes take effect on next login, or immediately via session revocation.</span>
    </div>
  )

  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        <Typography variant="subtitle2">Role Mappings</Typography>
        <Tooltip title={tooltipContent} arrow>
          <IconButton size="small" aria-label="Role mapping info">
            <HelpCircle size={16} />
          </IconButton>
        </Tooltip>
      </div>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Role</TableCell>
            <TableCell>OIDC Group</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {roleMappings.map(({ role, group }) => (
            <TableRow key={role}>
              <TableCell>{role}</TableCell>
              <TableCell className="font-mono">{group}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ----- Users Table -----

function UsersTable() {
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['auth-users'],
    queryFn: () => listUsers(),
  })

  return (
    <div>
      <Typography variant="subtitle2" className="mb-2">Users</Typography>
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <CircularProgress size={16} />
          <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">Loading users…</Typography>
        </div>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Last Login</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">No users found.</Typography>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{user.name ?? '—'}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{user.role}</TableCell>
                  <TableCell>{formatDate(user.lastLogin)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

// ----- Sessions Table -----

function SessionsTable() {
  const queryClient = useQueryClient()

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => listSessions(),
  })

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => revokeSession({ data: { sessionId } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }) },
  })

  const revokeAllMutation = useMutation({
    mutationFn: (userId: number) => revokeAllUserSessions({ data: { userId } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }) },
  })

  // Group sessions by userId to support "Revoke All" per user
  const userIds = [...new Set(sessions.map((s) => s.userId))].sort((a, b) => a - b)

  return (
    <div>
      <Typography variant="subtitle2" className="mb-2">Active Sessions</Typography>
      <Alert severity="info" className="mb-2">
        Role changes in your OIDC provider take effect on next login. To apply immediately, revoke the user&apos;s sessions.
      </Alert>
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <CircularProgress size={16} />
          <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">Loading sessions…</Typography>
        </div>
      ) : sessions.length === 0 ? (
        <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)] py-2">No active sessions.</Typography>
      ) : (
        userIds.map((userId) => {
          const userSessions = sessions.filter((s) => s.userId === userId)
          const firstSession = userSessions[0]
          const displayName = firstSession ? (firstSession.userName ?? firstSession.userEmail) : String(userId)

          return (
            <div key={userId} className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <Typography variant="body2" className="font-semibold">{displayName}</Typography>
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  disabled={revokeAllMutation.isPending}
                  onClick={() => revokeAllMutation.mutate(userId)}
                  aria-label={`Revoke all sessions for ${displayName}`}
                >
                  Revoke All Sessions
                </Button>
              </div>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell>IP Address</TableCell>
                    <TableCell>User Agent</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Expires</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {userSessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell>
                        <div>{session.userName ?? '—'}</div>
                        <div className="text-xs text-[var(--mui-palette-text-secondary)]">{session.userEmail}</div>
                      </TableCell>
                      <TableCell>{session.ipAddress ?? '—'}</TableCell>
                      <TableCell>
                        <Tooltip title={session.userAgent ?? ''} arrow>
                          <span>{truncate(session.userAgent ?? '', 50)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell>{formatDate(session.createdAt)}</TableCell>
                      <TableCell>{formatDate(session.expiresAt)}</TableCell>
                      <TableCell>
                        <Tooltip title="Revoke session">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              disabled={revokeMutation.isPending}
                              onClick={() => revokeMutation.mutate(session.id)}
                              aria-label="Revoke session"
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        })
      )}
    </div>
  )
}

// ----- Generate Token Dialog -----

interface GenerateTokenDialogProps {
  open: boolean
  onClose: () => void
  onGenerate: (label: string) => void
  isGenerating: boolean
  newToken: string | null
}

function GenerateTokenDialog({ open, onClose, onGenerate, isGenerating, newToken }: GenerateTokenDialogProps) {
  const [label, setLabel] = useState('')

  function handleGenerate() {
    if (!label.trim() || isGenerating) return
    onGenerate(label.trim())
  }

  function handleClose() {
    setLabel('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Generate Git Token</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        {newToken ? (
          <>
            <Alert severity="warning">
              Copy this token now — it will not be shown again.
            </Alert>
            <div className="p-3 rounded bg-[var(--mui-palette-background-level1)]">
              <Typography variant="body2" className="font-mono break-all">{newToken}</Typography>
            </div>
          </>
        ) : (
          <>
            <DialogContentText>Enter a label to identify this token.</DialogContentText>
            <TextField
              label="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              size="small"
              disabled={isGenerating}
              fullWidth
              inputProps={{ 'aria-label': 'Token label' }}
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        {newToken ? (
          <Button onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={isGenerating}>Cancel</Button>
            <Button
              onClick={handleGenerate}
              variant="contained"
              disabled={!label.trim() || isGenerating}
            >
              {isGenerating ? <CircularProgress size={16} /> : 'Generate'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}

// ----- Git Tokens Table -----

function GitTokensTable() {
  const queryClient = useQueryClient()
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)

  const { data: tokens = [], isLoading } = useQuery({
    queryKey: ['git-tokens'],
    queryFn: () => listGitTokens(),
  })

  const generateMutation = useMutation({
    mutationFn: (label: string) => createGitToken({ data: { label } }),
    onSuccess: (result) => {
      setNewToken(result.token)
      void queryClient.invalidateQueries({ queryKey: ['git-tokens'] })
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (tokenId: number) => revokeGitToken({ data: { tokenId } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['git-tokens'] }) },
  })

  function handleDialogClose() {
    setGenerateDialogOpen(false)
    setNewToken(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Typography variant="subtitle2">Git Tokens</Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={() => setGenerateDialogOpen(true)}
        >
          Generate Token
        </Button>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <CircularProgress size={16} />
          <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">Loading tokens…</Typography>
        </div>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>User</TableCell>
              <TableCell>Label</TableCell>
              <TableCell>Last Used</TableCell>
              <TableCell>Created</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {tokens.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">No tokens.</Typography>
                </TableCell>
              </TableRow>
            ) : (
              tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell>{token.userName ?? token.userEmail}</TableCell>
                  <TableCell>{token.label}</TableCell>
                  <TableCell>{token.lastUsedAt ? formatDate(token.lastUsedAt) : '—'}</TableCell>
                  <TableCell>{formatDate(token.createdAt)}</TableCell>
                  <TableCell>
                    <Tooltip title="Revoke token">
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(token.id)}
                          aria-label="Revoke token"
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      <GenerateTokenDialog
        open={generateDialogOpen}
        onClose={handleDialogClose}
        onGenerate={(label) => generateMutation.mutate(label)}
        isGenerating={generateMutation.isPending}
        newToken={newToken}
      />
    </div>
  )
}

// ----- Main Card -----

/**
 * Admin-only card for managing OIDC role mappings, users, sessions, and git tokens.
 */
export function AuthManagementCard() {
  return (
    <Card variant="outlined" className="p-4">
      <Typography variant="h6" className="mb-4">Auth Management</Typography>
      <div className="flex flex-col gap-6">
        <RoleMappingPanel />
        <UsersTable />
        <SessionsTable />
        <GitTokensTable />
      </div>
    </Card>
  )
}

// ----- Helpers -----

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Date(date).toLocaleString()
  } catch {
    return '—'
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}
