import { Card, Typography } from '@mui/joy'
import type { ProxmoxVM, ProxmoxContainer } from '@/types/proxmox'
import { formatBytes } from '@/formatters/metrics'

type GuestVM = ProxmoxVM & { node: string }
type GuestCT = ProxmoxContainer & { node: string }

interface GuestTableProps {
  vms: GuestVM[]
  containers: GuestCT[]
}

type GuestRow = {
  type: 'vm' | 'ct'
  vmid: number
  name: string
  node: string
  status: string
  cpu: number
  cpus: number
  mem: number
  maxmem: number
  uptime: number
  netin: number
  netout: number
}

function toRow(vm: GuestVM): GuestRow
function toRow(ct: GuestCT): GuestRow
function toRow(g: GuestVM | GuestCT): GuestRow {
  return {
    type: 'cpus' in g && !('swap' in g) ? 'vm' : 'ct',
    vmid: g.vmid,
    name: g.name,
    node: g.node,
    status: g.status,
    cpu: g.cpu,
    cpus: g.cpus,
    mem: g.mem,
    maxmem: g.maxmem,
    uptime: g.uptime,
    netin: g.netin,
    netout: g.netout,
  }
}

export default function GuestTable({ vms, containers }: GuestTableProps) {
  const guests: GuestRow[] = [
    ...vms.map((vm) => toRow(vm)),
    ...containers.map((ct) => toRow(ct)),
  ].sort((a, b) => a.vmid - b.vmid)

  if (guests.length === 0) {
    return (
      <Card variant="outlined" className="mb-6">
        <Typography level="title-lg" className="mb-3">Guests</Typography>
        <Typography level="body-sm" className="text-neutral-500">No VMs or containers found.</Typography>
      </Card>
    )
  }

  return (
    <Card variant="outlined" className="mb-6">
      <Typography level="title-lg" className="mb-3">
        Guests ({guests.length})
      </Typography>
      <div
        className="grid gap-px bg-neutral-200 dark:bg-neutral-700 rounded-lg overflow-hidden"
        style={{ gridTemplateColumns: '60px 50px minmax(120px, 1fr) 100px 80px 100px 120px 100px 100px' }}
      >
        {/* Header */}
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">VMID</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Type</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Name</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Node</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Status</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">CPU</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Memory</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Net In</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Net Out</div>

        {/* Rows */}
        {guests.map((guest) => {
          const cpuPercent = (guest.cpu * 100).toFixed(1)
          const memPercent = guest.maxmem > 0 ? ((guest.mem / guest.maxmem) * 100).toFixed(1) : '0'

          return (
            <div key={`${guest.type}-${guest.vmid}`} className="contents">
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 font-mono text-sm">{guest.vmid}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2">
                <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                  guest.type === 'vm'
                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                    : 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                }`}>
                  {guest.type === 'vm' ? 'VM' : 'CT'}
                </span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 font-medium truncate">{guest.name}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-sm text-neutral-500">{guest.node}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  guest.status === 'running'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                }`}>
                  {guest.status}
                </span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {guest.status === 'running' ? `${cpuPercent}%` : '-'}
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {guest.status === 'running'
                  ? <>{memPercent}% <span className="text-neutral-400">({formatBytes(guest.maxmem, false, false)})</span></>
                  : formatBytes(guest.maxmem, false, false)
                }
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {guest.status === 'running' ? formatBytes(guest.netin, false, false) : '-'}
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {guest.status === 'running' ? formatBytes(guest.netout, false, false) : '-'}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
