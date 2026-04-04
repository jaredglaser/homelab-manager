import { useState } from 'react'
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  MenuItem,
  Select,
  Switch,
  Typography,
} from '@mui/material'

export interface StackSettingsDialogProps {
  open: boolean
  currentHost: string
  currentAutoDeploy: boolean
  availableHosts: string[]
  isLoading: boolean
  onSave: (host: string, autoDeploy: boolean) => void
  onClose: () => void
}

/** Settings dialog for changing host and deploy mode */
export default function StackSettingsDialog({
  open,
  currentHost,
  currentAutoDeploy,
  availableHosts,
  isLoading,
  onSave,
  onClose,
}: Readonly<StackSettingsDialogProps>) {
  const [host, setHost] = useState(currentHost)
  const [autoDeploy, setAutoDeploy] = useState(currentAutoDeploy)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setHost(currentHost)
      setAutoDeploy(currentAutoDeploy)
    }
  }

  function handleSave() {
    if (!host || isLoading) return
    onSave(host, autoDeploy)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Stack Settings</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        <FormControl fullWidth disabled={isLoading}>
          <FormLabel className="!text-sm !mb-1">Target Host</FormLabel>
          <Select
            value={host}
            onChange={(e) => setHost(e.target.value)}
            displayEmpty
            inputProps={{ 'aria-label': 'Target Host' }}
          >
            {availableHosts.map((h) => (
              <MenuItem key={h} value={h}>{h}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <div className="flex items-center gap-3">
          <Switch
            checked={autoDeploy}
            onChange={(e) => setAutoDeploy(e.target.checked)}
            disabled={isLoading}
            inputProps={{ 'aria-label': 'Auto Deploy' }}
          />
          <div>
            <Typography variant="body2" className="font-medium">Auto Deploy</Typography>
            <Typography variant="caption" className="opacity-70">
              {autoDeploy ? 'Deploy on every git push' : 'Deploy only when triggered manually'}
            </Typography>
          </div>
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={isLoading}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={!host || isLoading}>
          {isLoading ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
