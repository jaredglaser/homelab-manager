import { Alert } from '@mui/material'
import { AlertTriangle } from 'lucide-react'

interface StaleDataAlertProps {
  isStale: boolean
}

/**
 * Displays a warning alert indicating the background worker may not be running when data is stale.
 *
 * @param isStale - Whether data is considered stale; when `true` the alert is rendered.
 * @returns A React element with a warning alert message when `isStale` is `true`, or `null` otherwise.
 */
export function StaleDataAlert({ isStale }: StaleDataAlertProps) {
  if (!isStale) return null
  return (
    <Alert
      severity="warning"
      icon={<AlertTriangle size={18} />}
      className="mb-3"
    >
      Data is stale. Background worker may not be running.
    </Alert>
  )
}
