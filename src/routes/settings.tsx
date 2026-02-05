import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import SettingsForm from '../components/settings/SettingsForm'

export const Route = createFileRoute('/settings')({
  ssr: false,
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <AppShell>
      <SettingsForm />
    </AppShell>
  )
}
