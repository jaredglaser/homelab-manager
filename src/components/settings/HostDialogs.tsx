import { useState } from 'react'
import {
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  CircularProgress,
} from '@mui/material'
import type { HostListItem } from '@/lib/hosts/host-utils'

interface RemoveDialogProps {
  open: boolean
  hostName: string
  isRemoving: boolean
  onConfirm: () => void
  onClose: () => void
}

export function RemoveDialog({ open, hostName, isRemoving, onConfirm, onClose }: RemoveDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Remove Host</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Remove <strong>{hostName}</strong>? This will also delete all deploy history for this host. The agent stack on that host will need to be stopped manually.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isRemoving}>Cancel</Button>
        <Button onClick={onConfirm} color="error" disabled={isRemoving}>
          {isRemoving ? <CircularProgress size={16} /> : 'Remove'}
        </Button>
      </DialogActions>
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

  const isValid = name.trim().length > 0 && agentUrl.trim().length > 0

  function handleSave() {
    if (!host || !isValid || isUpdating) return
    onConfirm(host.id, name.trim(), agentUrl.trim())
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Host</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        <TextField
          label="Host Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          size="small"
          disabled={isUpdating}
          fullWidth
          inputProps={{ 'aria-label': 'Edit Host Name' }}
        />
        <TextField
          label="Agent URL"
          value={agentUrl}
          onChange={(e) => setAgentUrl(e.target.value)}
          size="small"
          disabled={isUpdating}
          fullWidth
          inputProps={{ 'aria-label': 'Edit Agent URL' }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isUpdating}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={!isValid || isUpdating}>
          {isUpdating ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
