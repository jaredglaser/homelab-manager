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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { Spinner } from '@/components/ui/spinner';

interface RemoveDialogProps {
  open: boolean
  hostName: string
  isRemoving: boolean
  onConfirm: () => void
  onClose: () => void
}

export function RemoveDialog({ open, hostName, isRemoving, onConfirm, onClose }: RemoveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="w-auto min-w-75">
        <DialogTitle>Remove Host</DialogTitle>
        <DialogBody>
          <DialogDescription className="px-0">
            Remove <strong>{hostName}</strong>? This will also delete all deploy history for this host. The agent stack on that host will need to be stopped manually.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isRemoving}>Cancel</Button>
          <Button variant="ghost" className="text-destructive" onClick={onConfirm} disabled={isRemoving}>
            {isRemoving ? <Spinner className="size-4" /> : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface EditDialogProps {
  open: boolean
  host: HostListItem | null
  isUpdating: boolean
  onConfirm: (hostId: number, name: string, agentUrl: string) => void
  onClose: () => void
}

export function EditDialog({ open, host, isUpdating, onConfirm, onClose }: EditDialogProps) {
  const [name, setName] = useState(host?.name ?? '')
  const [agentUrl, setAgentUrl] = useState(host?.agentUrl ?? '')

  const [prevHost, setPrevHost] = useState(host)
  if (host !== prevHost) {
    setPrevHost(host)
    setName(host?.name ?? '')
    setAgentUrl(host?.agentUrl ?? '')
  }

  const isValid = agentUrl.trim().length > 0

  function handleSave() {
    if (!host || !isValid || isUpdating) return
    onConfirm(host.id, name.trim(), agentUrl.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent>
        <DialogTitle>Edit Host</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-host-name">Host Name</Label>
            <Input
              id="edit-host-name"
              value={name}
              disabled
              aria-label="Edit Host Name"
            />
            <p className="text-xs text-muted-foreground">
              Name is fixed after enrollment. To rename, remove and re-add the host.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-agent-url">Agent URL</Label>
            <Input
              id="edit-agent-url"
              value={agentUrl}
              onChange={(e) => setAgentUrl(e.target.value)}
              disabled={isUpdating}
              aria-label="Edit Agent URL"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isUpdating}>Cancel</Button>
          <Button onClick={handleSave} disabled={!isValid || isUpdating}>
            {isUpdating ? <Spinner className="size-4" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
