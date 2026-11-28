import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDrive, KeyRound, Plus, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { getZfsNodeSetupScript, removeZfsNode, verifyZfsNode } from '@/data/zfs/functions'
import { ZFS_NODES_QUERY_KEY, useZfsNodeNoticeFormatter, useZfsNodes } from '@/hooks/useZfsNodes'
import { useToast } from '@/hooks/toastAtom'
import { serverFnErrorMessage } from '@/lib/errors/server-fn-error-copy'
import { connectedMessage, type ZfsNodeState, type ZfsNodeSummary } from '@/lib/zfs/node-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { AddZfsNodeDialog, SetupScript, ZFS_NODE_CHECK_FAILED_MESSAGE, zfsProbeFailureMessage } from '@/components/zfs-nodes/AddZfsNodeDialog'

const STATE_BADGE: Record<ZfsNodeState, { label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' }> = {
  ok: { label: 'Connected', variant: 'success' },
  pending: { label: 'Not confirmed', variant: 'outline' },
  unreachable: { label: 'Unreachable', variant: 'warning' },
  host_key_changed: { label: 'Host key changed', variant: 'destructive' },
  key_refused: { label: 'Key refused', variant: 'destructive' },
  influxdb_missing: { label: 'zpool_influxdb missing', variant: 'warning' },
  timeout: { label: 'Not answering', variant: 'warning' },
  error: { label: 'Read failed', variant: 'destructive' },
}

export const ZFS_NODE_REMOVE_FAILED_MESSAGE = "Couldn't remove the node. Reload the page and try again."
export const ZFS_NODE_SCRIPT_FAILED_MESSAGE = "Couldn't load the setup script. Reload the page and try again."

export function removeZfsNodeMessage(name: string): string {
  return `Remove ${name}? Collection stops at once and its stored history is kept. To revoke the app's key on the node, run userdel hlm there.`
}

function NodeRow({
  node,
  notice,
  feedback,
  checking,
  onConfirmKey,
  onShowScript,
  onCheck,
  onRemove,
}: {
  node: ZfsNodeSummary
  notice: string | null
  feedback: string | null
  checking: boolean
  onConfirmKey: () => void
  onShowScript: () => void
  onCheck: () => void
  onRemove: () => void
}) {
  const badge = STATE_BADGE[node.state]
  return (
    <div className="px-4 py-3 border-b border-border last:border-0" data-testid={`zfs-node-row-${node.name}`}>
      <div className="flex flex-wrap items-center gap-3">
        <HardDrive size={16} className="text-muted-foreground shrink-0" aria-hidden />
        <div className="flex-1 min-w-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold truncate">{node.name}</p>
            <Badge variant={badge.variant} className="text-[10px]">{badge.label}</Badge>
          </div>
          <span className="text-xs font-mono text-muted-foreground block truncate">{node.address}:{node.port}</span>
          {node.hostKeyFingerprint && (
            <span className="text-[11px] font-mono text-muted-foreground block truncate" title="Confirmed host key">{node.hostKeyFingerprint}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0 ml-auto">
          {(node.state === 'host_key_changed' || node.state === 'pending') && (
            <Button requires="admin" size="sm" variant="outline" onClick={onConfirmKey} aria-label={`Confirm host key of ${node.name}`}>
              <KeyRound size={14} />
              <span className="ml-1">{node.state === 'pending' ? 'Confirm key' : 'Confirm new key'}</span>
            </Button>
          )}
          <Button requires="admin" size="sm" variant="outline" onClick={onShowScript} aria-label={`Show setup script for ${node.name}`}>
            <ScrollText size={14} />
            <span className="ml-1">Setup script</span>
          </Button>
          {node.hostKeyFingerprint && (
            <Button requires="write" size="sm" variant="outline" onClick={onCheck} disabled={checking} aria-label={`Check ${node.name} again`}>
              {checking ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
              <span className="ml-1">Check</span>
            </Button>
          )}
          <Button requires="admin" size="sm" variant="ghost" className="text-destructive" onClick={onRemove} aria-label={`Remove ${node.name}`}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      {notice && <p className="text-xs text-muted-foreground mt-1.5 break-words" data-testid={`zfs-node-notice-${node.name}`}>{notice}</p>}
      {feedback && <p role="status" aria-live="polite" className="text-xs text-muted-foreground mt-1.5">{feedback}</p>}
    </div>
  )
}

function SetupScriptDialog({ node, onClose }: { node: ZfsNodeSummary | null; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['zfs-node-setup-script', node?.id],
    queryFn: () => getZfsNodeSetupScript({ data: { id: node!.id } }),
    enabled: node !== null,
  })
  return (
    <Dialog open={node !== null} busy={false} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Setup script for {node?.name}</DialogTitle>
        <DialogBody className="pt-1">
          {isLoading && <Spinner className="size-4" />}
          {isError && <p role="alert" className="text-sm text-destructive">{ZFS_NODE_SCRIPT_FAILED_MESSAGE}</p>}
          {data && <SetupScript script={data.setupScript} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveNodeDialog({ node, removing, onConfirm, onClose }: { node: ZfsNodeSummary | null; removing: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open={node !== null} busy={removing} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="w-auto min-w-75 max-w-lg">
        <DialogTitle>Remove ZFS node</DialogTitle>
        <DialogBody>
          <DialogDescription className="px-0">{node ? removeZfsNodeMessage(node.name) : ''}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="ghost" className="text-destructive" onClick={onConfirm}>
            {removing ? <Spinner className="size-4" /> : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ZfsNodesCard() {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const { data: nodes = [], isLoading, isError } = useZfsNodes()
  const formatNotice = useZfsNodeNoticeFormatter()
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState<ZfsNodeSummary | null>(null)
  const [scriptFor, setScriptFor] = useState<ZfsNodeSummary | null>(null)
  const [removing, setRemoving] = useState<ZfsNodeSummary | null>(null)
  const [feedback, setFeedback] = useState<Record<number, string>>({})

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ZFS_NODES_QUERY_KEY })

  const check = useMutation({
    mutationFn: (node: ZfsNodeSummary) => verifyZfsNode({ data: { id: node.id } }),
    onSuccess: (result, node) => {
      setFeedback((prev) => ({ ...prev, [node.id]: result.ok ? connectedMessage(node.name, result.pools) : zfsProbeFailureMessage(node, result.failure) }))
      refresh()
    },
    onError: (err) => showToast(serverFnErrorMessage(err, ZFS_NODE_CHECK_FAILED_MESSAGE), 'error'),
  })

  const remove = useMutation({
    mutationFn: (node: ZfsNodeSummary) => removeZfsNode({ data: { id: node.id } }),
    onSuccess: () => {
      setRemoving(null)
      refresh()
    },
    onError: (err) => {
      setRemoving(null)
      showToast(serverFnErrorMessage(err, ZFS_NODE_REMOVE_FAILED_MESSAGE), 'error')
    },
  })

  return (
    <section className="flex flex-col gap-2 max-w-2xl px-4 pb-6" aria-labelledby="zfs-nodes-heading">
      <div className="flex items-center justify-between">
        <h2 id="zfs-nodes-heading" className="text-sm font-semibold">ZFS nodes</h2>
        <Button requires="admin" size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus size={14} />
          <span className="ml-1">Add ZFS node</span>
        </Button>
      </div>
      <div className="bg-card rounded-lg border border-border">
        {isLoading && (
          <div className="p-4 flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading ZFS nodes…</div>
        )}
        {isError && <p className="p-4 text-sm text-destructive">The ZFS node list could not be fetched. Check the server logs and reload the page.</p>}
        {!isLoading && !isError && nodes.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">No ZFS nodes yet. Add one to read its pools over SSH.</p>
        )}
        {nodes.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            notice={formatNotice(node)}
            feedback={feedback[node.id] ?? null}
            checking={check.isPending && check.variables?.id === node.id}
            onConfirmKey={() => setConfirming(node)}
            onShowScript={() => setScriptFor(node)}
            onCheck={() => check.mutate(node)}
            onRemove={() => setRemoving(node)}
          />
        ))}
      </div>
      <AddZfsNodeDialog
        open={adding || confirming !== null}
        resumeNode={confirming}
        onChanged={refresh}
        onClose={() => {
          setAdding(false)
          setConfirming(null)
          refresh()
        }}
      />
      <SetupScriptDialog node={scriptFor} onClose={() => setScriptFor(null)} />
      <RemoveNodeDialog
        node={removing}
        removing={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => setRemoving(null)}
      />
    </section>
  )
}
