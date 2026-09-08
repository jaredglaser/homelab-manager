import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import CopyButton from '@/components/settings/CopyButton'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { Spinner } from '@/components/ui/spinner';

interface KeypairDialogProps {
  open: boolean
  host: HostListItem | null
  publicJwkJson: string | null
  isLoading: boolean
  isRotating: boolean
  onView: (hostId: number) => void
  onRotate: (hostId: number) => void
  onClose: () => void
}

export function KeypairDialog({
  open,
  host,
  publicJwkJson,
  isLoading,
  isRotating,
  onView,
  onRotate,
  onClose,
}: KeypairDialogProps) {
  const [confirmingRotate, setConfirmingRotate] = useState(false)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setConfirmingRotate(false)
      if (host) onView(host.id)
    }
  }

  const [prevHostId, setPrevHostId] = useState(host?.id)
  if (host?.id !== prevHostId) {
    setPrevHostId(host?.id)
    setConfirmingRotate(false)
  }

  function handleRotate() {
    if (!host || isRotating) return
    if (!confirmingRotate) {
      setConfirmingRotate(true)
      return
    }
    onRotate(host.id)
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent>
        <DialogTitle>Agent Keypair</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          {isLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Spinner className="size-4" />
              <p className="text-sm text-muted-foreground">Loading keypair…</p>
            </div>
          ) : publicJwkJson ? (
            <>
              <DialogDescription className="px-0">
                Public key for <strong>{host?.name}</strong>. The agent must trust this key via{' '}
                <code>AGENT_TRUSTED_PUBKEY</code> in its environment.
              </DialogDescription>
              <Alert variant="info">
                <AlertDescription className="w-full">
                  <pre className="text-xs w-full overflow-auto p-2 rounded bg-level1 text-foreground" data-testid="host-pubkey-display">
                    {publicJwkJson}
                  </pre>
                  <CopyButton text={publicJwkJson} label="public key" />
                </AlertDescription>
              </Alert>
              {confirmingRotate && (
                <Alert variant="error">
                  <AlertDescription>
                    Rotating replaces the stored keypair. Until you set the new key as{' '}
                    <code>AGENT_TRUSTED_PUBKEY</code> on the agent and restart it, every authenticated
                    call to this agent will fail.
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <DialogDescription className="px-0">
              No keypair is stored for this host yet.
            </DialogDescription>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isRotating}>Close</Button>
          {publicJwkJson && (
            <Button
              variant={confirmingRotate ? 'destructive' : 'ghost'}
              onClick={handleRotate}
              disabled={isRotating}
            >
              {isRotating ? <Spinner className="size-4" /> : null}
              {confirmingRotate ? 'Confirm rotation' : 'Rotate keypair'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
