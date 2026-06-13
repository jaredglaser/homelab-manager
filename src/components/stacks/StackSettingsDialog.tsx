import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

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
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent>
        <DialogTitle>Stack Settings</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settings-target-host" className="text-sm mb-1">Target Host</Label>
            <Select
              value={host}
              onValueChange={(value) => { if (value) setHost(value) }}
              disabled={isLoading}
            >
              <SelectTrigger id="settings-target-host" aria-label="Target Host">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableHosts.map((h) => (
                  <SelectItem key={h} value={h}>{h}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={autoDeploy}
              onCheckedChange={setAutoDeploy}
              disabled={isLoading}
              aria-label="Auto Deploy"
            />
            <div>
              <p className="text-sm font-medium">Auto Deploy</p>
              <p className="text-xs opacity-70">
                {autoDeploy ? 'Deploy on every git push' : 'Deploy only when triggered manually'}
              </p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={onClose} disabled={isLoading}>Cancel</Button>
          <Button onClick={handleSave} disabled={!host || isLoading}>
            {isLoading ? <Spinner className="size-4" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
