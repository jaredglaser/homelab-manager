import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listZfsNodes } from '@/data/zfs/functions'
import { formatNoticeTime, zfsNodeNotice, type ZfsNodeSummary } from '@/lib/zfs/node-state'
import { useGeneralSettings } from '@/hooks/useSettings'

export const ZFS_NODES_QUERY_KEY = ['zfs-nodes'] as const

/** The worker updates node states in the database, so the list is polled rather than pushed. */
const ZFS_NODES_REFRESH_MS = 5000

export function useZfsNodes() {
  return useQuery({
    queryKey: ZFS_NODES_QUERY_KEY,
    queryFn: (): Promise<ZfsNodeSummary[]> => listZfsNodes(),
    refetchInterval: ZFS_NODES_REFRESH_MS,
  })
}

export function useZfsNodeNoticeFormatter(): (node: ZfsNodeSummary) => string | null {
  const { general } = useGeneralSettings()
  return useMemo(
    () => (node: ZfsNodeSummary) => zfsNodeNotice(node, (ms) => formatNoticeTime(ms, general.use12HourTime)),
    [general.use12HourTime],
  )
}

/** Notices by node name for the ZFS page host rows. */
export function useZfsNodeNotices(): ReadonlyMap<string, string> {
  const { data } = useZfsNodes()
  const format = useZfsNodeNoticeFormatter()
  return useMemo(() => {
    const notices = new Map<string, string>()
    for (const node of data ?? []) {
      const notice = format(node)
      if (notice !== null) notices.set(node.name, notice)
    }
    return notices
  }, [data, format])
}
