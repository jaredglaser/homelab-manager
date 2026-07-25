import { useEffect } from 'react'
import { createFileRoute, useLocation } from '@tanstack/react-router'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  useDockerSettings,
  useGeneralSettings,
  useZfsSettings,
  type MemoryDisplayMode,
  type DecimalSettings,
  type LightPalette,
} from '@/hooks/useSettings'
import PageTitle from '@/components/PageTitle'
import { ManagedHostsCard } from '@/components/settings/ManagedHostsCardConnected'
import { AuthManagementCard } from '@/components/settings/AuthManagementCard'
import { useAuth } from '@/hooks/useAuth'
import {
  CHART_WINDOW_MARKS,
  UPDATE_INTERVAL_MARKS,
  RAW_DATA_MARKS,
  MINUTE_AGG_MARKS,
  RAW_RETENTION_HOURS,
  MINUTE_AGG_RETENTION_DAYS,
  formatChartWindow,
  formatUpdateInterval,
  formatHours,
  formatDays,
  formatDecimalLabel,
} from '@/lib/constants/settings-ui'

export const Route = createFileRoute('/settings')({
  ssr: false,
  component: SettingsContent,
})

const noopRetentionChange = () => {};

function SettingsContent() {
  const {
    general,
    developer,
    setUse12HourTime,
    setUpdateInterval,
    setShowSparklines,
    setUseAbbreviatedUnits,
    setLightPalette,
    setDockerDebugLogging,
    setDbFlushDebugLogging,
    setSseDebugLogging,
  } = useGeneralSettings();
  const { docker, setMemoryDisplayMode, setChartWindowSeconds, setDockerDecimal } = useDockerSettings();
  const { zfs, setZfsDecimal } = useZfsSettings();
  const { user } = useAuth();
  const hash = useLocation({ select: (l) => l.hash });

  useEffect(() => {
    if (!hash) return;
    const scroll = () => {
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
      return false;
    };
    if (scroll()) return;
    const raf = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(raf);
  }, [hash]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <PageTitle title="Settings" />

      <div className="flex flex-col gap-4 max-w-2xl px-4 pb-6">
        <div id="general" className="p-4 scroll-mt-20 bg-card rounded-lg border border-border">
          <h6 className="text-xl font-medium mb-4">General</h6>
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center">
              <Label>Use 12-hour time format</Label>
              <Switch
                checked={general.use12HourTime}
                onCheckedChange={setUse12HourTime}
              />
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <Label>Update Interval</Label>
                <p className="text-sm font-mono">{formatUpdateInterval(general.updateIntervalMs)}</p>
              </div>
              <span className="text-xs text-muted-foreground mb-3 block">
                Controls how frequently stats are collected and displayed (requires worker restart)
              </span>
              <Slider
                value={general.updateIntervalMs}
                onValueChange={setUpdateInterval}
                min={100}
                max={60000}
                marks={UPDATE_INTERVAL_MARKS}
                aria-label="Update Interval"
              />
            </div>
            <div className="flex justify-between items-center">
              <Label>Show Sparklines</Label>
              <Switch
                checked={general.showSparklines}
                onCheckedChange={setShowSparklines}
              />
            </div>

            <div className="flex justify-between items-center">
              <Label>Use Abbreviated Units</Label>
              <Switch
                checked={general.useAbbreviatedUnits}
                onCheckedChange={setUseAbbreviatedUnits}
              />
            </div>

            <div className="flex flex-col">
              <Label className="mb-1">Light Mode Palette</Label>
              <span className="text-xs text-muted-foreground mb-2 block">
                Background color palette used in light mode
              </span>
              <Select
                value={general.lightPalette}
                onValueChange={(value) => { if (value) setLightPalette(value as LightPalette); }}
              >
                <SelectTrigger aria-label="Light Mode Palette">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cool-blue">Cool Blue</SelectItem>
                  <SelectItem value="dusty-rose">Dusty Rose</SelectItem>
                  <SelectItem value="forest-mist">Forest Mist</SelectItem>
                  <SelectItem value="soft-stone">Soft Stone</SelectItem>
                  <SelectItem value="warm-slate">Warm Slate</SelectItem>
                </SelectContent>
              </Select>
            </div>

          </div>
        </div>

        <div id="docker-dashboard" className="p-4 scroll-mt-20 bg-card rounded-lg border border-border">
          <h6 className="text-xl font-medium mb-4">Docker Containers Dashboard</h6>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label>Memory Display</Label>
              <Select
                value={docker.memoryDisplayMode}
                onValueChange={(value) => {
                  if (value) setMemoryDisplayMode(value as MemoryDisplayMode);
                }}
              >
                <SelectTrigger aria-label="Memory Display">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="bytes">Bytes (B, KiB, MiB, GiB)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <Label>Chart Window</Label>
                <p className="text-sm font-mono">
                  {formatChartWindow(docker.chartWindowSeconds)}
                </p>
              </div>
              <span className="text-xs text-muted-foreground mb-3 block">
                Time range shown in the expanded container metric charts
              </span>
              <Slider
                value={docker.chartWindowSeconds}
                onValueChange={setChartWindowSeconds}
                min={60}
                max={1800}
                marks={CHART_WINDOW_MARKS}
                aria-label="Chart Window"
              />
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Show Decimal Places</p>
              <div className="flex flex-col gap-2">
                {(Object.keys(docker.decimals) as (keyof DecimalSettings)[]).map((key) => (
                  <div key={key} className="flex justify-between items-center">
                    <Label>{formatDecimalLabel(key)}</Label>
                    <Switch
                      checked={docker.decimals[key]}
                      onCheckedChange={(checked) => setDockerDecimal(key, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div id="zfs-dashboard" className="p-4 scroll-mt-20 bg-card rounded-lg border border-border">
          <h6 className="text-xl font-medium mb-4">ZFS Dashboard</h6>
          <div>
            <p className="text-sm font-medium mb-2">Show Decimal Places</p>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <Label>Disk Speed</Label>
                <Switch
                  checked={zfs.decimals.diskSpeed}
                  onCheckedChange={(checked) => setZfsDecimal('diskSpeed', checked)}
                />
              </div>
            </div>
          </div>
        </div>

        <div id="data-retention" className="p-4 scroll-mt-20 bg-card rounded-lg border border-border">
          <h6 className="text-xl font-medium mb-4">Data Retention</h6>
          <div className="flex flex-col gap-6">
            <div>
              <div className="flex justify-between items-baseline mb-1">
                <Label>Raw Data</Label>
                <p className="text-sm font-mono">{formatHours(RAW_RETENTION_HOURS)}</p>
              </div>
              <span className="text-xs text-muted-foreground mb-3 block">
                Second-level data is rolled up into minute averages, then dropped after this period
              </span>
              <Slider
                value={RAW_RETENTION_HOURS}
                onValueChange={noopRetentionChange}
                min={1}
                max={168}
                marks={RAW_DATA_MARKS}
                disabled
                aria-label="Raw Data retention"
              />
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <Label>Minute Aggregates</Label>
                <p className="text-sm font-mono">{formatDays(MINUTE_AGG_RETENTION_DAYS)}</p>
              </div>
              <span className="text-xs text-muted-foreground mb-3 block">
                Minute averages are rolled up into hourly averages, then dropped after this period
              </span>
              <Slider
                value={MINUTE_AGG_RETENTION_DAYS}
                onValueChange={noopRetentionChange}
                min={1}
                max={30}
                marks={MINUTE_AGG_MARKS}
                disabled
                aria-label="Minute Aggregates retention"
              />
            </div>

            <div className="flex justify-between items-baseline">
              <div>
                <Label>Hour Aggregates</Label>
                <span className="text-xs text-muted-foreground block">
                  Hourly averages are the permanent tier and are never dropped
                </span>
              </div>
              <p className="text-sm font-mono">Kept forever</p>
            </div>
          </div>
        </div>

        <div id="managed-hosts" className="scroll-mt-20">
          <ManagedHostsCard />
        </div>

        {user?.role === 'admin' && <AuthManagementCard />}

        <div id="developer" className="p-4 scroll-mt-20 bg-card rounded-lg border border-border">
          <h6 className="text-xl font-medium mb-4">Developer</h6>
          <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <div>
                <Label>Docker Debug Logging</Label>
                <span className="text-xs text-muted-foreground block">
                  Log connection lifecycle, stream events, and collection timing
                </span>
              </div>
              <Switch
                checked={developer.dockerDebugLogging}
                onCheckedChange={setDockerDebugLogging}
              />
            </div>
            <div className="flex justify-between items-center">
              <div>
                <Label>Database Flush Logging</Label>
                <span className="text-xs text-muted-foreground block">
                  Log batch flush counts and database write timing
                </span>
              </div>
              <Switch
                checked={developer.dbFlushDebugLogging}
                onCheckedChange={setDbFlushDebugLogging}
              />
            </div>
            <div className="flex justify-between items-center">
              <div>
                <Label>SSE Pipeline Logging</Label>
                <span className="text-xs text-muted-foreground block">
                  Log NOTIFY reception, cache updates, and SSE event emission
                </span>
              </div>
              <Switch
                checked={developer.sseDebugLogging}
                onCheckedChange={setSseDebugLogging}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
