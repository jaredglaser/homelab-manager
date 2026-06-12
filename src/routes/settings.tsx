import { useEffect } from 'react'
import { createFileRoute, useLocation } from '@tanstack/react-router'
import { Card, FormControl, FormLabel, MenuItem, Select, Slider, Typography } from '@mui/material'
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
  HOUR_AGG_MARKS,
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

function SettingsContent() {
  const {
    general,
    retention,
    developer,
    setUse12HourTime,
    setUpdateInterval,
    setShowSparklines,
    setUseAbbreviatedUnits,
    setLightPalette,
    setRetention,
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
        <Card id="general" variant="outlined" className="p-4 scroll-mt-20">
          <Typography variant="h6" className="mb-4">General</Typography>
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center">
              <FormLabel>Use 12-hour time format</FormLabel>
              <Switch
                checked={general.use12HourTime}
                onCheckedChange={setUse12HourTime}
              />
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Update Interval</FormLabel>
                <Typography variant="body2" className="font-mono">{formatUpdateInterval(general.updateIntervalMs)}</Typography>
              </div>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-3 block">
                Controls how frequently stats are collected and displayed (requires worker restart)
              </Typography>
              <Slider
                value={general.updateIntervalMs}
                onChange={(_e, v) => setUpdateInterval(v as number)}
                min={100}
                max={60000}
                step={null}
                marks={UPDATE_INTERVAL_MARKS}
              />
            </div>
            <div className="flex justify-between items-center">
              <FormLabel>Show Sparklines</FormLabel>
              <Switch
                checked={general.showSparklines}
                onCheckedChange={setShowSparklines}
              />
            </div>

            <div className="flex justify-between items-center">
              <FormLabel>Use Abbreviated Units</FormLabel>
              <Switch
                checked={general.useAbbreviatedUnits}
                onCheckedChange={setUseAbbreviatedUnits}
              />
            </div>

            <FormControl>
              <FormLabel>Light Mode Palette</FormLabel>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-2 block">
                Background color palette used in light mode
              </Typography>
              <Select
                value={general.lightPalette}
                onChange={(e) => { if (e.target.value) setLightPalette(e.target.value as LightPalette); }}
                size="small"
              >
                <MenuItem value="cool-blue">Cool Blue</MenuItem>
                <MenuItem value="dusty-rose">Dusty Rose</MenuItem>
                <MenuItem value="forest-mist">Forest Mist</MenuItem>
                <MenuItem value="soft-stone">Soft Stone</MenuItem>
                <MenuItem value="warm-slate">Warm Slate</MenuItem>
              </Select>
            </FormControl>

          </div>
        </Card>

        <Card id="docker-dashboard" variant="outlined" className="p-4 scroll-mt-20">
          <Typography variant="h6" className="mb-4">Docker Containers Dashboard</Typography>
          <div className="flex flex-col gap-4">
            <FormControl>
              <FormLabel>Memory Display</FormLabel>
              <Select
                value={docker.memoryDisplayMode}
                onChange={(e) => {
                  if (e.target.value) setMemoryDisplayMode(e.target.value as MemoryDisplayMode);
                }}
                size="small"
              >
                <MenuItem value="percentage">Percentage (%)</MenuItem>
                <MenuItem value="bytes">Bytes (B, KiB, MiB, GiB)</MenuItem>
              </Select>
            </FormControl>

            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Chart Window</FormLabel>
                <Typography variant="body2" className="font-mono">
                  {formatChartWindow(docker.chartWindowSeconds)}
                </Typography>
              </div>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-3 block">
                Time range shown in the expanded container metric charts
              </Typography>
              <Slider
                value={docker.chartWindowSeconds}
                onChange={(_e, v) => setChartWindowSeconds(v as number)}
                min={60}
                max={1800}
                step={null}
                marks={CHART_WINDOW_MARKS}
              />
            </div>

            <div>
              <Typography variant="subtitle2" className="mb-2">Show Decimal Places</Typography>
              <div className="flex flex-col gap-2">
                {(Object.keys(docker.decimals) as (keyof DecimalSettings)[]).map((key) => (
                  <div key={key} className="flex justify-between items-center">
                    <FormLabel>{formatDecimalLabel(key)}</FormLabel>
                    <Switch
                      checked={docker.decimals[key]}
                      onCheckedChange={(checked) => setDockerDecimal(key, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card id="zfs-dashboard" variant="outlined" className="p-4 scroll-mt-20">
          <Typography variant="h6" className="mb-4">ZFS Dashboard</Typography>
          <div>
            <Typography variant="subtitle2" className="mb-2">Show Decimal Places</Typography>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <FormLabel>Disk Speed</FormLabel>
                <Switch
                  checked={zfs.decimals.diskSpeed}
                  onCheckedChange={(checked) => setZfsDecimal('diskSpeed', checked)}
                />
              </div>
            </div>
          </div>
        </Card>

        <Card id="data-retention" variant="outlined" className="p-4 scroll-mt-20">
          <Typography variant="h6" className="mb-4">Data Retention</Typography>
          <div className="flex flex-col gap-6">
            <div>
              <div className="flex justify-between items-baseline mb-1">
                <FormLabel>Raw Data</FormLabel>
                <Typography variant="body2" className="font-mono">{formatHours(retention.rawDataHours)}</Typography>
              </div>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-3 block">
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
                <Typography variant="body2" className="font-mono">{formatDays(retention.minuteAggDays)}</Typography>
              </div>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-3 block">
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
                <Typography variant="body2" className="font-mono">{formatDays(retention.hourAggDays)}</Typography>
              </div>
              <Typography variant="caption" className="text-(--mui-palette-text-secondary) mb-3 block">
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

        <div id="managed-hosts" className="scroll-mt-20">
          <ManagedHostsCard />
        </div>

        {user?.role === 'admin' && <AuthManagementCard />}

        <Card id="developer" variant="outlined" className="p-4 scroll-mt-20">
          <Typography variant="h6" className="mb-4">Developer</Typography>
          <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <div>
                <FormLabel>Docker Debug Logging</FormLabel>
                <Typography variant="caption" className="text-(--mui-palette-text-secondary) block">
                  Log connection lifecycle, stream events, and collection timing
                </Typography>
              </div>
              <Switch
                checked={developer.dockerDebugLogging}
                onCheckedChange={setDockerDebugLogging}
              />
            </div>
            <div className="flex justify-between items-center">
              <div>
                <FormLabel>Database Flush Logging</FormLabel>
                <Typography variant="caption" className="text-(--mui-palette-text-secondary) block">
                  Log batch flush counts and database write timing
                </Typography>
              </div>
              <Switch
                checked={developer.dbFlushDebugLogging}
                onCheckedChange={setDbFlushDebugLogging}
              />
            </div>
            <div className="flex justify-between items-center">
              <div>
                <FormLabel>SSE Pipeline Logging</FormLabel>
                <Typography variant="caption" className="text-(--mui-palette-text-secondary) block">
                  Log NOTIFY reception, cache updates, and SSE event emission
                </Typography>
              </div>
              <Switch
                checked={developer.sseDebugLogging}
                onCheckedChange={setSseDebugLogging}
              />
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
