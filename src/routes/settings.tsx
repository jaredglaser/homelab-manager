import { createFileRoute } from '@tanstack/react-router'
import AppShell from '../components/AppShell'
import { Card, FormControl, FormLabel, Option, Select, Slider, Switch, Typography } from '@mui/joy'
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
  const { general, docker, zfs, retention, developer, setUse12HourTime, setMemoryDisplayMode, setShowSparklines, setUseAbbreviatedUnits, setDockerDecimal, setZfsDecimal, setRetention, setDockerDebugLogging, setDbFlushDebugLogging, setSseDebugLogging } = useSettings();

  return (
    <div className="w-full p-6">
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-4 max-w-2xl">
        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">General</Typography>
          <div className="flex flex-col gap-6">
            <FormControl orientation="horizontal" className="justify-between">
              <FormLabel>Use 12-hour time format</FormLabel>
              <Switch
                checked={general.use12HourTime}
                onChange={(e) => setUse12HourTime(e.target.checked)}
              />
            </FormControl>

            <FormControl orientation="horizontal" className="justify-between">
              <FormLabel>Show Sparklines</FormLabel>
              <Switch
                checked={general.showSparklines}
                onChange={(e) => setShowSparklines(e.target.checked)}
              />
            </FormControl>

            <FormControl orientation="horizontal" className="justify-between">
              <FormLabel>Use Abbreviated Units</FormLabel>
              <Switch
                checked={general.useAbbreviatedUnits}
                onChange={(e) => setUseAbbreviatedUnits(e.target.checked)}
              />
            </FormControl>

          </div>
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

        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">Data Retention</Typography>
          <div className="flex flex-col gap-6">
            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Raw Data</FormLabel>
                <Typography level="body-sm" className="font-mono">{formatHours(retention.rawDataHours)}</Typography>
              </div>
              <Typography level="body-xs" className="text-neutral-500 mb-3">
                Second-level data is downsampled to minute averages after this period
              </Typography>
              <Slider
                value={retention.rawDataHours}
                onChange={(_e, v) => setRetention('rawDataHours', v as number)}
                min={1}
                max={168}
                step={null}
                marks={RAW_DATA_MARKS}
              />
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Minute Aggregates</FormLabel>
                <Typography level="body-sm" className="font-mono">{formatDays(retention.minuteAggDays)}</Typography>
              </div>
              <Typography level="body-xs" className="text-neutral-500 mb-3">
                Minute averages are downsampled to hourly averages after this period
              </Typography>
              <Slider
                value={retention.minuteAggDays}
                onChange={(_e, v) => setRetention('minuteAggDays', v as number)}
                min={1}
                max={30}
                step={null}
                marks={MINUTE_AGG_MARKS}
              />
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Hour Aggregates</FormLabel>
                <Typography level="body-sm" className="font-mono">{formatDays(retention.hourAggDays)}</Typography>
              </div>
              <Typography level="body-xs" className="text-neutral-500 mb-3">
                Hourly averages are downsampled to daily averages after this period. Daily data is kept forever.
              </Typography>
              <Slider
                value={retention.hourAggDays}
                onChange={(_e, v) => setRetention('hourAggDays', v as number)}
                min={1}
                max={365}
                step={null}
                marks={HOUR_AGG_MARKS}
              />
            </div>
          </div>
        </Card>

        <Card variant="outlined">
          <Typography level="title-lg" className="mb-4">Developer</Typography>
          <div className="flex flex-col gap-4">
            <FormControl orientation="horizontal" className="justify-between">
              <div>
                <FormLabel>Docker Debug Logging</FormLabel>
                <Typography level="body-xs" className="text-neutral-500">
                  Log connection lifecycle, stream events, and collection timing
                </Typography>
              </div>
              <Switch
                checked={developer.dockerDebugLogging}
                onChange={(e) => setDockerDebugLogging(e.target.checked)}
              />
            </FormControl>
            <FormControl orientation="horizontal" className="justify-between">
              <div>
                <FormLabel>Database Flush Logging</FormLabel>
                <Typography level="body-xs" className="text-neutral-500">
                  Log batch flush counts and database write timing
                </Typography>
              </div>
              <Switch
                checked={developer.dbFlushDebugLogging}
                onChange={(e) => setDbFlushDebugLogging(e.target.checked)}
              />
            </FormControl>
            <FormControl orientation="horizontal" className="justify-between">
              <div>
                <FormLabel>SSE Pipeline Logging</FormLabel>
                <Typography level="body-xs" className="text-neutral-500">
                  Log NOTIFY reception, cache updates, and SSE event emission
                </Typography>
              </div>
              <Switch
                checked={developer.sseDebugLogging}
                onChange={(e) => setSseDebugLogging(e.target.checked)}
              />
            </FormControl>
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

// --- Retention slider marks and formatters ---

const RAW_DATA_MARKS = [1, 2, 4, 8, 12, 24, 48, 72, 120, 168].map(v => ({ value: v }));
const MINUTE_AGG_MARKS = [1, 2, 3, 5, 7, 14, 21, 30].map(v => ({ value: v }));
const HOUR_AGG_MARKS = [1, 7, 14, 30, 60, 90, 180, 365].map(v => ({ value: v }));

function formatHours(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
  return `${hours} hours`;
}

function formatDays(days: number): string {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  if (days % 30 === 0 && days >= 30) {
    const months = days / 30;
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  if (days % 7 === 0 && days < 30) {
    const weeks = days / 7;
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}
