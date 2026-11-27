import { Alert, AlertDescription } from '@/components/ui/alert'
import type { ProxmoxStateMessage } from '@/lib/channels/proxmox-state'
import type { ProxmoxCollectorState } from '@/types/proxmox'

export const PROXMOX_NOT_SET_UP = "Proxmox isn't set up. Add your cluster in Settings, under Proxmox."
export const PROXMOX_COLLECTOR_OFF =
  "The worker isn't collecting Proxmox stats. Set WORKER_PROXMOX_ENABLED=true on the worker container and restart it."
export const PROXMOX_TOKEN_REJECTED =
  'Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.'
export const PROXMOX_CERTIFICATE_REFUSED =
  "Proxmox's certificate isn't trusted. Allow self-signed certificates for this connection, or give Proxmox a trusted certificate."
export const PROXMOX_LIVE_CONNECTION_LOST = 'Lost the live connection. Reconnecting…'

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatClockTime(ms: number, use12Hour: boolean): string {
  const d = new Date(ms)
  if (!use12Hour) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const h12 = ((d.getHours() + 11) % 12) + 1
  return `${h12}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

export function unreachableMessage(connection: Pick<ProxmoxCollectorState, 'host' | 'port' | 'lastSuccessAt'>, use12Hour: boolean): string {
  const where = `Can't reach Proxmox at ${connection.host}:${connection.port}.`
  if (connection.lastSuccessAt === null) return where
  return `${where} Showing the last data, from ${formatClockTime(connection.lastSuccessAt, use12Hour)}.`
}

export interface ProxmoxNotice {
  key: string
  text: string
}

/** Notices for the worker's recorded state. `null` means the state has not arrived yet, which shows nothing. */
export function proxmoxStateNotices(snapshot: ProxmoxStateMessage | null, use12Hour: boolean): ProxmoxNotice[] {
  if (snapshot === null) return []
  if (snapshot.connections.length === 0) return [{ key: 'not-set-up', text: PROXMOX_NOT_SET_UP }]
  return snapshot.connections.flatMap((connection): ProxmoxNotice[] => {
    const key = connection.connectionId
    switch (connection.state) {
      case 'collecting':
        return []
      case 'collector_off':
        return [{ key, text: PROXMOX_COLLECTOR_OFF }]
      case 'unreachable':
        return [{ key, text: unreachableMessage(connection, use12Hour) }]
      case 'token_rejected':
        return [{ key, text: PROXMOX_TOKEN_REJECTED }]
      case 'certificate_refused':
        return [{ key, text: PROXMOX_CERTIFICATE_REFUSED }]
    }
  })
}

/** True when the worker reports a connection that is collecting, or nothing has arrived yet: worth a loading spinner. */
export function proxmoxDataExpected(snapshot: ProxmoxStateMessage | null): boolean {
  return snapshot === null || snapshot.connections.some((c) => c.state === 'collecting')
}

export function ProxmoxNoticeList({ notices }: Readonly<{ notices: ProxmoxNotice[] }>) {
  if (notices.length === 0) return null
  return (
    <div className="flex flex-col gap-2 mb-3">
      {notices.map((notice) => (
        <Alert key={notice.key} variant="warning">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ))}
    </div>
  )
}
