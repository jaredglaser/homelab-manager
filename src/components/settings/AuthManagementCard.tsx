import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HelpCircle, Trash2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listUsers, listSessions, revokeSession, revokeAllUserSessions, getRoleMapping } from '@/data/auth.functions'
import { listGitTokens, createGitToken, revokeGitToken } from '@/data/git-tokens.functions'
import { Spinner } from '@/components/ui/spinner';
import { useIsMobile } from '@/hooks/useMediaQuery'
import type { ReactNode } from 'react'

function MobileField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right break-words">{value}</span>
    </div>
  )
}

function RoleMappingPanel() {
  const { data: roleMapping } = useQuery({
    queryKey: ['role-mapping'],
    queryFn: () => getRoleMapping(),
  })

  const roleMappings: { role: string; group: string }[] = [
    { role: 'Admin', group: roleMapping?.admin ?? 'homelab-admins' },
    { role: 'Operator', group: roleMapping?.operator ?? 'homelab-operators' },
    { role: 'Viewer', group: roleMapping?.viewer ?? 'homelab-viewers' },
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
        <p className="text-sm font-medium">Role Mappings</p>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" className="text-foreground" aria-label="Role mapping info" />}
          >
            <HelpCircle size={16} />
          </TooltipTrigger>
          <TooltipContent>{tooltipContent}</TooltipContent>
        </Tooltip>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead>OIDC Group</TableHead>
          </TableRow>
        </TableHeader>
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

function UsersTable() {
  const isMobile = useIsMobile()
  const { data: users = [], isLoading, isError, error } = useQuery({
    queryKey: ['auth-users'],
    queryFn: () => listUsers(),
  })

  return (
    <div>
      <p className="text-sm font-medium mb-2">Users</p>
      {isError ? (
        <Alert variant="error" className="mb-2">
          <AlertDescription>Failed to load users: {error instanceof Error ? error.message : 'Unknown error'}</AlertDescription>
        </Alert>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner className="size-4" />
          <p className="text-sm text-muted-foreground">Loading users…</p>
        </div>
      ) : isMobile ? (
        users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users found.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {users.map((user) => (
              <div key={user.id} className="rounded-lg border border-border p-3 flex flex-col gap-1.5">
                <p className="text-sm font-semibold truncate">{user.name ?? '—'}</p>
                <p className="text-xs text-muted-foreground break-all">{user.email}</p>
                <MobileField label="Role" value={user.role} />
                <MobileField label="Last Login" value={formatDate(user.lastLogin)} />
              </div>
            ))}
          </div>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last Login</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <p className="text-sm text-muted-foreground">No users found.</p>
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

function SessionsTable() {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()

  const { data: sessions = [], isLoading, isError, error } = useQuery({
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
      <p className="text-sm font-medium mb-2">Active Sessions</p>
      <Alert variant="info" className="mb-2">
        <AlertDescription>
          Role changes in your OIDC provider take effect on next login. To apply immediately, revoke the user&apos;s sessions.
        </AlertDescription>
      </Alert>
      {isError ? (
        <Alert variant="error" className="mb-2">
          <AlertDescription>Failed to load sessions: {error instanceof Error ? error.message : 'Unknown error'}</AlertDescription>
        </Alert>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner className="size-4" />
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No active sessions.</p>
      ) : (
        userIds.map((userId) => {
          const userSessions = sessions.filter((s) => s.userId === userId)
          const firstSession = userSessions[0]
          const displayName = firstSession ? (firstSession.userName ?? firstSession.userEmail) : String(userId)

          return (
            <div key={userId} className="mb-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-sm font-semibold truncate min-w-0">{displayName}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5 shrink-0"
                  disabled={revokeAllMutation.isPending}
                  onClick={() => revokeAllMutation.mutate(userId)}
                  aria-label={`Revoke all sessions for ${displayName}`}
                >
                  Revoke All Sessions
                </Button>
              </div>
              {isMobile ? (
                <div className="flex flex-col gap-2">
                  {userSessions.map((session) => (
                    <div key={session.id} className="rounded-lg border border-border p-3 flex flex-col gap-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{session.userName ?? '—'}</p>
                          <p className="text-xs text-muted-foreground truncate">{session.userEmail}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive shrink-0"
                          disabled={revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(session.id)}
                          aria-label="Revoke session"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                      <MobileField label="IP Address" value={session.ipAddress ?? '—'} />
                      <div className="text-xs">
                        <span className="text-muted-foreground">User Agent</span>
                        <p className="break-words mt-0.5">{session.userAgent ?? '—'}</p>
                      </div>
                      <MobileField label="Created" value={formatDate(session.createdAt)} />
                      <MobileField label="Expires" value={formatDate(session.expiresAt)} />
                    </div>
                  ))}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>IP Address</TableHead>
                      <TableHead>User Agent</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {userSessions.map((session) => (
                      <TableRow key={session.id}>
                        <TableCell>
                          <div>{session.userName ?? '—'}</div>
                          <div className="text-xs text-muted-foreground">{session.userEmail}</div>
                        </TableCell>
                        <TableCell>{session.ipAddress ?? '—'}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger render={<span />}>{truncate(session.userAgent ?? '', 50)}</TooltipTrigger>
                            <TooltipContent>{session.userAgent ?? ''}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>{formatDate(session.createdAt)}</TableCell>
                        <TableCell>{formatDate(session.expiresAt)}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-destructive"
                                  disabled={revokeMutation.isPending}
                                  onClick={() => revokeMutation.mutate(session.id)}
                                  aria-label="Revoke session"
                                />
                              }
                            >
                              <Trash2 size={14} />
                            </TooltipTrigger>
                            <TooltipContent>Revoke session</TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

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
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}>
      <DialogContent>
        <DialogTitle>Generate Git Token</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          {newToken ? (
            <>
              <Alert variant="warning">
                <AlertDescription>Copy this token now — it will not be shown again.</AlertDescription>
              </Alert>
              <div className="p-3 rounded bg-level1">
                <p className="text-sm font-mono break-all">{newToken}</p>
              </div>
            </>
          ) : (
            <>
              <DialogDescription className="px-0">Enter a label to identify this token.</DialogDescription>
              <div className="flex flex-col gap-1">
                <Label htmlFor="git-token-label">Label</Label>
                <Input
                  id="git-token-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={isGenerating}
                  aria-label="Token label"
                />
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {newToken ? (
            <Button variant="ghost" onClick={handleClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={isGenerating}>Cancel</Button>
              <Button onClick={handleGenerate} disabled={!label.trim() || isGenerating}>
                {isGenerating ? <Spinner className="size-4" /> : 'Generate'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GitTokensTable() {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)

  const { data: tokens = [], isLoading, isError, error } = useQuery({
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
        <p className="text-sm font-medium">Git Tokens</p>
        <Button size="sm" variant="outline" onClick={() => setGenerateDialogOpen(true)}>
          Generate Token
        </Button>
      </div>
      {isError ? (
        <Alert variant="error" className="mb-2">
          <AlertDescription>Failed to load tokens: {error instanceof Error ? error.message : 'Unknown error'}</AlertDescription>
        </Alert>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner className="size-4" />
          <p className="text-sm text-muted-foreground">Loading tokens…</p>
        </div>
      ) : isMobile ? (
        tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {tokens.map((token) => (
              <div key={token.id} className="rounded-lg border border-border p-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{token.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{token.userName ?? token.userEmail}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive shrink-0"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(token.id)}
                    aria-label="Revoke token"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                <MobileField label="Last Used" value={token.lastUsedAt ? formatDate(token.lastUsedAt) : '—'} />
                <MobileField label="Created" value={formatDate(token.createdAt)} />
              </div>
            ))}
          </div>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <p className="text-sm text-muted-foreground">No tokens.</p>
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
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate(token.id)}
                            aria-label="Revoke token"
                          />
                        }
                      >
                        <Trash2 size={14} />
                      </TooltipTrigger>
                      <TooltipContent>Revoke token</TooltipContent>
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

/**
 * Admin-only card for managing OIDC role mappings, users, sessions, and git tokens.
 */
export function AuthManagementCard() {
  return (
    <div className="p-4 bg-card rounded-lg border border-border">
      <h6 className="text-xl font-medium mb-4">Auth Management</h6>
      <div className="flex flex-col gap-6">
        <RoleMappingPanel />
        <UsersTable />
        <SessionsTable />
        <GitTokensTable />
      </div>
    </div>
  )
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString()
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}
