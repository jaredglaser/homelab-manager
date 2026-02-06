import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import { Box, Card, FormControl, FormLabel, Option, Select, Typography } from '@mui/joy'
import { useSettings, type MemoryDisplayMode } from '@/hooks/useSettings'

export const Route = createFileRoute('/settings')({
  ssr: false,
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <AppShell>
      <SettingsContent />
    </AppShell>
  )
}

function SettingsContent() {
  const { docker, setMemoryDisplayMode } = useSettings();

  return (
    <Box className="w-full p-6">
      <Typography level="h2" className="mb-6">Settings</Typography>

      <div className="flex flex-col gap-4 max-w-2xl">
        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">Docker Containers Dashboard</Typography>
          <FormControl>
            <FormLabel>Memory Display</FormLabel>
            <Select
              value={docker.memoryDisplayMode}
              onChange={(_event, value) => {
                if (value) setMemoryDisplayMode(value as MemoryDisplayMode);
              }}
            >
              <Option value="percentage">Percentage (%)</Option>
              <Option value="bytes">Bytes (B, KiB, MiB, GiB)</Option>
            </Select>
          </FormControl>
        </Card>
      </div>
    </Box>
  )
}
