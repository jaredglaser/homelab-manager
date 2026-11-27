import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { checkedOnFill, ActionReason, Field, blockedReason, fieldIssues } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { agentUrlSchema } from '@/data/hosts/schemas'
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
    <Dialog open={open} busy={isRemoving} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="w-auto min-w-75">
        <DialogTitle>Remove Host</DialogTitle>
        <DialogBody>
          <DialogDescription className="px-0">
            Remove <strong>{hostName}</strong>? This will also delete all deploy history for this host. The agent stack on that host will need to be stopped manually.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="ghost" className="text-destructive" onClick={onConfirm}>
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

const editHostFormSchema = z.object({ agentUrl: z.string().trim().pipe(agentUrlSchema) })
type EditHostFormValues = z.infer<typeof editHostFormSchema>

export function EditDialog({ open, host, isUpdating, onConfirm, onClose }: EditDialogProps) {
  const form = useForm<EditHostFormValues>({
    mode: 'onTouched',
    values: { agentUrl: host?.agentUrl ?? '' },
    resolver: zodResolver(editHostFormSchema),
  })
  const values = form.watch()
  const check = editHostFormSchema.safeParse(values)
  const reason = blockedReason(fieldIssues(check), {
    isTouched: () => Boolean(form.formState.touchedFields.agentUrl),
    isEmpty: () => values.agentUrl.trim() === '',
  })

  const handleSave = form.handleSubmit(({ agentUrl }) => {
    if (!host || isUpdating) return
    onConfirm(host.id, host.name, agentUrl)
  })

  return (
    <Dialog open={open} busy={isUpdating} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent>
        <DialogTitle>Edit Host</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          <Field
            id="edit-host-name"
            label="Host Name"
            hint="Name is fixed after enrollment. To rename, remove and re-add the host."
          >
            {(control) => <Input {...control} value={host?.name ?? ''} disabled aria-label="Edit Host Name" />}
          </Field>
          <Field id="edit-agent-url" label="Agent URL" error={form.formState.errors.agentUrl?.message}>
            {(control) => (
              <Input {...control} disabled={isUpdating} aria-label="Edit Agent URL" {...checkedOnFill(form.register('agentUrl'))} />
            )}
          </Field>
        </DialogBody>
        <DialogFooter>
          {reason && <ActionReason className="mr-auto min-w-0 pl-4">{reason}</ActionReason>}
          <Button variant="ghost" className="shrink-0" onClick={onClose}>Cancel</Button>
          <Button className="shrink-0" onClick={() => { void handleSave() }} disabled={!check.success}>
            {isUpdating ? <Spinner className="size-4" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
