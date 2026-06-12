import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle } from 'lucide-react'

interface StaleDataAlertProps {
  isStale: boolean
}

export function StaleDataAlert({ isStale }: StaleDataAlertProps) {
  if (!isStale) return null
  return (
    <Alert variant="warning" className="mb-3">
      <AlertTriangle size={18} />
      <AlertDescription>Data is stale. Background worker may not be running.</AlertDescription>
    </Alert>
  )
}
