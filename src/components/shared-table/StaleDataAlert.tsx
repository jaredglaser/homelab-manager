import { Alert } from '@mui/joy'
import { AlertTriangle } from 'lucide-react'

interface StaleDataAlertProps {
  isStale: boolean
}

export function StaleDataAlert({ isStale }: StaleDataAlertProps) {
  if (!isStale) return null
  return (
    <Alert
      color="warning"
      variant="soft"
      startDecorator={<AlertTriangle size={18} />}
      className="mb-3"
    >
      Data is stale. Background worker may not be running.
    </Alert>
  )
}
