import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Paper, IconButton } from '@mui/material'
import { CheckCircle, AlertCircle, AlertTriangle, X } from 'lucide-react'
import { getNotifications, dismissNotification } from '@/data/notification.functions'
import type { Notification } from '@/lib/database/repositories/notification-repository'
import type { LucideIcon } from 'lucide-react'

const MAX_VISIBLE = 5

const severityConfig: Record<
  Notification['severity'],
  { icon: LucideIcon; containerClass: string; iconClass: string }
> = {
  success: {
    icon: CheckCircle,
    containerClass: 'bg-green-900/90 text-green-100',
    iconClass: 'text-green-400',
  },
  error: {
    icon: AlertCircle,
    containerClass: 'bg-red-900/90 text-red-100',
    iconClass: 'text-red-400',
  },
  warning: {
    icon: AlertTriangle,
    containerClass: 'bg-amber-900/90 text-amber-100',
    iconClass: 'text-amber-400',
  },
}

function NotificationToast({
  notification,
  onDismiss,
}: {
  notification: Notification
  onDismiss: (id: number) => void
}) {
  const config = severityConfig[notification.severity] ?? severityConfig.warning
  const SeverityIcon = config.icon

  return (
    <Paper
      elevation={6}
      className={`${config.containerClass} !rounded-lg animate-[fadeIn_0.3s_ease-in] max-w-sm w-full`}
    >
      <div className="flex items-start gap-3 p-3">
        <SeverityIcon className={`${config.iconClass} mt-0.5 shrink-0`} size={20} />
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm">{notification.title}</div>
          <div className="text-sm opacity-90">{notification.message}</div>
        </div>
        <IconButton
          size="small"
          onClick={() => onDismiss(notification.id)}
          className="!text-inherit !-mt-1 !-mr-1 shrink-0"
        >
          <X size={16} />
        </IconButton>
      </div>
    </Paper>
  )
}

export default function NotificationToasts() {
  const queryClient = useQueryClient()

  const { data: notifications } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: () => getNotifications(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const handleDismiss = async (id: number) => {
    await dismissNotification({ data: { id } })
    await queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  const visible = notifications?.slice(0, MAX_VISIBLE) ?? []

  if (visible.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {visible.map((notification) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  )
}
