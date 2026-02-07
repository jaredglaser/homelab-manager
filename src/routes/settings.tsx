import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import { Card, FormControl, FormLabel, Option, Select, Switch, Typography } from '@mui/joy'
import { useSettings, type MemoryDisplayMode, type DecimalSettings } from '@/hooks/useSettings'
import PageHeader from '@/components/PageHeader'

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
  const { general, docker, zfs, setUse12HourTime, setMemoryDisplayMode, setShowSparklines, setDockerDecimal, setZfsDecimal } = useSettings();

  return (
    <div className="w-full p-6">
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-4 max-w-2xl">
        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">General</Typography>
          <FormControl orientation="horizontal" className="justify-between">
            <FormLabel>Use 12-hour time format</FormLabel>
            <Switch
              checked={general.use12HourTime}
              onChange={(e) => setUse12HourTime(e.target.checked)}
            />
          </FormControl>
        </Card>

        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">Docker Containers Dashboard</Typography>
          <div className="flex flex-col gap-4">
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

            <FormControl orientation="horizontal" className="justify-between">
              <FormLabel>Show Sparklines</FormLabel>
              <Switch
                checked={docker.showSparklines}
                onChange={(e) => setShowSparklines(e.target.checked)}
              />
            </FormControl>

            <div>
              <Typography level="title-sm" className="mb-2">Show Decimal Places</Typography>
              <div className="flex flex-col gap-2">
                {(Object.keys(docker.decimals) as (keyof DecimalSettings)[]).map((key) => (
                  <FormControl key={key} orientation="horizontal" className="justify-between">
                    <FormLabel>{formatDecimalLabel(key)}</FormLabel>
                    <Switch
                      checked={docker.decimals[key]}
                      onChange={(e) => setDockerDecimal(key, e.target.checked)}
                    />
                  </FormControl>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">ZFS Dashboard</Typography>
          <div>
            <Typography level="title-sm" className="mb-2">Show Decimal Places</Typography>
            <div className="flex flex-col gap-2">
              <FormControl orientation="horizontal" className="justify-between">
                <FormLabel>Disk Speed</FormLabel>
                <Switch
                  checked={zfs.decimals.diskSpeed}
                  onChange={(e) => setZfsDecimal('diskSpeed', e.target.checked)}
                />
              </FormControl>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

function formatDecimalLabel(key: keyof DecimalSettings): string {
  const labels: Record<keyof DecimalSettings, string> = {
    cpu: 'CPU',
    memory: 'Memory',
    diskSpeed: 'Disk Speed',
    networkSpeed: 'Network Speed',
  };
  return labels[key];
}
