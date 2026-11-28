import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import CopyButton from '@/components/settings/CopyButton'
import {
  confirmZfsNodeHostKey,
  createZfsNode,
  scanZfsNodeHostKey,
  type ScanZfsNodeResult,
  type VerifyZfsNodeResult,
} from '@/data/zfs/functions'
import { serverFnErrorMessage } from '@/lib/errors/server-fn-error-copy'
import {
  SETUP_SCRIPT_INTRO,
  connectedMessage,
  hostKeyConfirmMessage,
  zfsNodeNotice,
  type ZfsNodeFailure,
  type ZfsNodeSummary,
} from '@/lib/zfs/node-state'

export const ZFS_NODE_NAME_TAKEN_MESSAGE = 'A ZFS node with this name already exists. Pick another name.'
export const ZFS_NODE_REMOVED_MESSAGE = 'This node was removed. Close this window and add it again.'
export const ZFS_NODE_ADD_FAILED_MESSAGE = "Couldn't add the node. Reload the page and try again."
export const ZFS_NODE_CHECK_FAILED_MESSAGE = "Couldn't check the node. Reload the page and try again."

export function zfsProbeFailureMessage(node: Pick<ZfsNodeSummary, 'name' | 'port'>, failure: ZfsNodeFailure | 'not_found' | 'not_confirmed'): string {
  if (failure === 'not_found') return ZFS_NODE_REMOVED_MESSAGE
  const state = failure === 'not_confirmed' ? 'pending' : failure
  return zfsNodeNotice({ name: node.name, port: node.port, state, lastSuccessAt: null }, () => '') ?? ''
}

type Step =
  | { kind: 'form' }
  | { kind: 'script'; node: ZfsNodeSummary; setupScript: string }
  | { kind: 'verify'; node: ZfsNodeSummary }

interface AddZfsNodeDialogProps {
  open: boolean
  onClose: () => void
  onChanged: () => void
  /** Opens at the verify step for a node already added, to confirm a changed host key. */
  resumeNode?: ZfsNodeSummary | null
}

export function SetupScript({ script }: { script: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" data-testid="zfs-setup-intro">{SETUP_SCRIPT_INTRO}</p>
      <div className="relative">
        <pre className="text-xs font-mono bg-level1 border border-border rounded p-2 max-h-64 overflow-auto whitespace-pre" data-testid="zfs-setup-script">{script}</pre>
        <div className="absolute top-1 right-1">
          <CopyButton text={script} label="setup script" />
        </div>
      </div>
    </div>
  )
}

export function AddZfsNodeDialog({ open, onClose, onChanged, resumeNode = null }: AddZfsNodeDialogProps) {
  const [step, setStep] = useState<Step>(resumeNode ? { kind: 'verify', node: resumeNode } : { kind: 'form' })
  const [prevResume, setPrevResume] = useState(resumeNode)
  const [prevOpen, setPrevOpen] = useState(open)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('22')
  const [allowedFrom, setAllowedFrom] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanZfsNodeResult | null>(null)
  const [verify, setVerify] = useState<VerifyZfsNodeResult | null>(null)
  const [callError, setCallError] = useState<string | null>(null)

  if (resumeNode !== prevResume || open !== prevOpen) {
    setPrevResume(resumeNode)
    setPrevOpen(open)
    if (open) {
      setStep(resumeNode ? { kind: 'verify', node: resumeNode } : { kind: 'form' })
      setScan(null)
      setVerify(null)
      setCallError(null)
      setFormError(null)
    }
  }

  const create = useMutation({
    mutationFn: () => createZfsNode({ data: { name: name.trim(), address: address.trim(), port: Number(port), allowedFrom: allowedFrom.trim() || undefined } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFormError(ZFS_NODE_NAME_TAKEN_MESSAGE)
        return
      }
      onChanged()
      setStep({ kind: 'script', node: result.node, setupScript: result.setupScript })
    },
    onError: (err) => setFormError(serverFnErrorMessage(err, ZFS_NODE_ADD_FAILED_MESSAGE)),
  })

  const scanKey = useMutation({
    mutationFn: (id: number) => scanZfsNodeHostKey({ data: { id } }),
    onMutate: () => {
      setScan(null)
      setVerify(null)
      setCallError(null)
    },
    onSuccess: (result) => setScan(result),
    onError: (err) => setCallError(serverFnErrorMessage(err, ZFS_NODE_CHECK_FAILED_MESSAGE)),
  })

  const confirmKey = useMutation({
    mutationFn: ({ id, fingerprint }: { id: number; fingerprint: string }) => confirmZfsNodeHostKey({ data: { id, fingerprint } }),
    onMutate: () => setCallError(null),
    onSuccess: (result) => {
      setVerify(result)
      onChanged()
    },
    onError: (err) => setCallError(serverFnErrorMessage(err, ZFS_NODE_CHECK_FAILED_MESSAGE)),
  })

  const resumeId = open ? resumeNode?.id ?? null : null
  const startScan = scanKey.mutate
  useEffect(() => {
    if (resumeId !== null) startScan(resumeId)
  }, [resumeId, startScan])

  const busy = create.isPending || scanKey.isPending || confirmKey.isPending
  const portNumber = Number(port)
  const formValid = name.trim() !== '' && address.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  function submitForm(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !formValid) return
    setFormError(null)
    create.mutate()
  }

  function goVerify(node: ZfsNodeSummary) {
    setStep({ kind: 'verify', node })
    scanKey.mutate(node.id)
  }

  const title = step.kind === 'verify' && resumeNode ? `Confirm ${resumeNode.name}'s host key` : 'Add ZFS node'

  return (
    <Dialog open={open} busy={busy} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{title}</DialogTitle>
        {step.kind === 'form' && (
          <form onSubmit={submitForm}>
            <DialogBody className="flex flex-col gap-3 pt-1">
              <DialogDescription className="px-0">
                The app reads the node's pools over SSH with a key of its own, through a user that cannot change them.
              </DialogDescription>
              <div className="flex flex-col gap-1">
                <Label htmlFor="zfs-node-name">Name</Label>
                <Input id="zfs-node-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="pve1" />
              </div>
              <div className="flex gap-3">
                <div className="flex flex-col gap-1 flex-1">
                  <Label htmlFor="zfs-node-address">Address</Label>
                  <Input id="zfs-node-address" value={address} onChange={(e) => setAddress(e.target.value)} disabled={busy} placeholder="192.168.1.10" />
                </div>
                <div className="flex flex-col gap-1 w-24">
                  <Label htmlFor="zfs-node-port">SSH port</Label>
                  <Input id="zfs-node-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} disabled={busy} />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="zfs-node-from">Worker address (optional)</Label>
                <Input id="zfs-node-from" value={allowedFrom} onChange={(e) => setAllowedFrom(e.target.value)} disabled={busy} placeholder="192.168.1.5" />
                <p className="text-xs text-muted-foreground">
                  When set, the node accepts the app's key only from this address. Separate several with commas.
                </p>
              </div>
              {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!formValid}>{create.isPending ? <Spinner className="size-4" /> : 'Next'}</Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === 'script' && (
          <>
            <DialogBody className="pt-1">
              <SetupScript script={step.setupScript} />
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button onClick={() => goVerify(step.node)}>I ran it, connect</Button>
            </DialogFooter>
          </>
        )}

        {step.kind === 'verify' && (
          <VerifyStep
            node={step.node}
            scan={scan}
            verify={verify}
            callError={callError}
            scanning={scanKey.isPending}
            confirming={confirmKey.isPending}
            onScan={() => scanKey.mutate(step.node.id)}
            onConfirm={(fingerprint) => confirmKey.mutate({ id: step.node.id, fingerprint })}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface VerifyStepProps {
  node: ZfsNodeSummary
  scan: ScanZfsNodeResult | null
  verify: VerifyZfsNodeResult | null
  callError: string | null
  scanning: boolean
  confirming: boolean
  onScan: () => void
  onConfirm: (fingerprint: string) => void
  onClose: () => void
}

function VerifyStep({ node, scan, verify, callError, scanning, confirming, onScan, onConfirm, onClose }: VerifyStepProps) {
  let body: React.ReactNode = <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Connecting to {node.name}…</div>
  let primary: React.ReactNode = null

  if (callError) {
    body = <p role="alert" className="text-sm text-destructive">{callError}</p>
    primary = <Button onClick={onScan}>Try again</Button>
  } else if (verify?.ok) {
    body = <p role="status" className="text-sm text-success" data-testid="zfs-node-connected">{connectedMessage(node.name, verify.pools)}</p>
    primary = <Button onClick={onClose}>Done</Button>
  } else if (verify && !verify.ok) {
    body = <Alert variant="warning"><AlertDescription data-testid="zfs-node-verify-failure">{zfsProbeFailureMessage(node, verify.failure)}</AlertDescription></Alert>
    primary = <Button onClick={onScan}>Try again</Button>
  } else if (scan && !scan.ok) {
    body = <Alert variant="warning"><AlertDescription data-testid="zfs-node-verify-failure">{zfsProbeFailureMessage(node, scan.failure)}</AlertDescription></Alert>
    primary = <Button onClick={onScan}>Try again</Button>
  } else if (scan?.ok && confirming) {
    body = <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Reading pools on {node.name}…</div>
  } else if (scan?.ok && scan.confirmed) {
    body = <p className="text-sm">The host key matches the one confirmed before.</p>
    primary = <Button onClick={() => onConfirm(scan.fingerprint)}>Connect</Button>
  } else if (scan?.ok) {
    body = <p className="text-sm break-words" data-testid="zfs-host-key-confirm">{hostKeyConfirmMessage(node.name, scan.fingerprint)}</p>
    primary = <Button onClick={() => onConfirm(scan.fingerprint)}>Confirm</Button>
  } else if (!scanning) {
    primary = <Button onClick={onScan}>Connect</Button>
  }

  return (
    <>
      <DialogBody className="pt-1 flex flex-col gap-3">{body}</DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{verify?.ok ? 'Close' : 'Cancel'}</Button>
        {primary}
      </DialogFooter>
    </>
  )
}
