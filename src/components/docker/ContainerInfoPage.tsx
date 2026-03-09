import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { X, ExternalLink, Pencil, Check, ArrowUpCircle } from 'lucide-react';
import { Button, CircularProgress } from '@mui/material';
import { rawSettingsAtom } from '@/hooks/settingsAtom';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { getContainerDetails, getContainerChangelog, updateContainerGithubRepo } from '@/data/docker.functions';
import UpdateDialog from '@/components/docker/UpdateDialog';
import type { ContainerDetails, GitHubRelease } from '@/types/container-versions';

interface ContainerInfoPageProps {
  containerId: string;
  host: string;
  image: string;
  containerName: string;
  serviceKeyEntity: string;
  onClose: () => void;
}

export default function ContainerInfoPage({
  containerId,
  host,
  image,
  containerName,
  serviceKeyEntity,
  onClose,
}: ContainerInfoPageProps) {
  const queryClient = useQueryClient();

  const { data: details, isLoading: detailsLoading } = useQuery({
    queryKey: ['container-details', containerId, host],
    queryFn: () => getContainerDetails({ data: { containerId, host } }),
    staleTime: 30_000,
  });

  const { data: changelog, isLoading: changelogLoading } = useQuery({
    queryKey: ['container-changelog', image],
    queryFn: () => getContainerChangelog({ data: { image } }),
    staleTime: 60_000,
  });

  return (
    <div className="px-6 pb-6 max-h-[calc(100vh-120px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between py-4 sticky top-0 z-10 !bg-[var(--mui-palette-background-default)]">
        <h2 className="text-lg font-semibold">{containerName}</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      {detailsLoading ? (
        <div className="flex justify-center py-12">
          <CircularProgress size={32} />
        </div>
      ) : details ? (
        <div className="flex flex-col gap-6">
          <OverviewSection details={details} />
          <VersionSection
            details={details}
            serviceKeyEntity={serviceKeyEntity}
            queryClient={queryClient}
            containerId={containerId}
            host={host}
            containerName={containerName}
          />
          <PortsSection ports={details.ports} />
          <VolumesSection volumes={details.volumes} />
          <ChangelogSection changelog={changelog ?? []} isLoading={changelogLoading} />
        </div>
      ) : (
        <p className="text-[var(--mui-palette-text-secondary)] py-8 text-center">
          Unable to load container details. The container may not be accessible.
        </p>
      )}
    </div>
  );
}

// ─── Section Components ──────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--mui-palette-text-secondary)] mb-2">
      {children}
    </h3>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="text-sm text-[var(--mui-palette-text-secondary)] min-w-[120px] flex-shrink-0">{label}</span>
      <span className="text-sm break-all">{children}</span>
    </div>
  );
}

function OverviewSection({ details }: { details: ContainerDetails }) {
  const statusColor = details.status === 'running'
    ? 'text-green-500'
    : details.status === 'exited'
      ? 'text-red-500'
      : 'text-amber-500';

  const created = details.created ? new Date(details.created) : null;
  const uptime = created ? formatUptime(Date.now() - created.getTime()) : 'Unknown';

  return (
    <section>
      <SectionHeading>Overview</SectionHeading>
      <div className="rounded-lg border border-[var(--mui-palette-divider)] p-3">
        <InfoRow label="Image">{details.image}</InfoRow>
        <InfoRow label="Container ID">
          <code className="text-xs bg-[var(--mui-palette-action-hover)] px-1.5 py-0.5 rounded">
            {details.containerId.substring(0, 12)}
          </code>
        </InfoRow>
        <InfoRow label="Status">
          <span className={`font-medium ${statusColor}`}>{details.status}</span>
        </InfoRow>
        <InfoRow label="Uptime">{uptime}</InfoRow>
        <InfoRow label="Restart Policy">{details.restartPolicy}</InfoRow>
      </div>
    </section>
  );
}

function VersionSection({
  details,
  serviceKeyEntity,
  queryClient,
  containerId,
  host,
  containerName,
}: {
  details: ContainerDetails;
  serviceKeyEntity: string;
  queryClient: ReturnType<typeof useQueryClient>;
  containerId: string;
  host: string;
  containerName: string;
}) {
  const [editing, setEditing] = useState(false);
  const [repoUrl, setRepoUrl] = useState(details.githubRepo ?? '');
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  const rawSettings = useAtomValue(rawSettingsAtom);
  const updateStatus = rawSettings[SETTINGS_KEYS.update.status];
  const updateInProgress = updateStatus !== undefined
    && updateStatus !== ''
    && updateStatus !== 'idle';

  const handleSave = useCallback(async () => {
    if (!repoUrl.trim()) return;
    try {
      await updateContainerGithubRepo({ data: { serviceKeyEntity, githubRepoUrl: repoUrl.trim() } });
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['container-details'] });
    } catch {
      // Error handled silently
    }
  }, [repoUrl, serviceKeyEntity, queryClient]);

  return (
    <section>
      <SectionHeading>Version & Updates</SectionHeading>
      <div className="rounded-lg border border-[var(--mui-palette-divider)] p-3">
        <InfoRow label="Current Tag">
          <code className="text-xs bg-[var(--mui-palette-action-hover)] px-1.5 py-0.5 rounded">
            {details.currentTag ?? 'unknown'}
          </code>
          {details.currentVersion && details.currentVersion !== details.currentTag && (
            <code className="text-xs bg-[var(--mui-palette-action-hover)] px-1.5 py-0.5 rounded ml-1">
              {details.currentVersion}
            </code>
          )}
        </InfoRow>
        <InfoRow label="Latest Tag">
          {details.latestTag ? (
            <code className="text-xs bg-[var(--mui-palette-action-hover)] px-1.5 py-0.5 rounded">
              {details.latestTag}
            </code>
          ) : (
            <span className="text-[var(--mui-palette-text-disabled)]">Not checked</span>
          )}
        </InfoRow>
        {details.updateAvailable && (
          <div className="flex items-center gap-2 mt-2 py-1.5 px-2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <ArrowUpCircle size={16} />
            <span className="text-sm font-medium">
              Update available: {details.currentVersion ?? details.currentTag} → {details.latestTag}
            </span>
          </div>
        )}
        {details.updateAvailable && (
          <Button
            variant="contained"
            size="small"
            onClick={() => setUpdateDialogOpen(true)}
            disabled={updateInProgress}
            className="!mt-2"
          >
            Update Container
          </Button>
        )}
        <div className="mt-2 pt-2 border-t border-[var(--mui-palette-divider)]">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--mui-palette-text-secondary)] min-w-[120px] flex-shrink-0">GitHub Repo</span>
            {editing ? (
              <div className="flex items-center gap-1 flex-1">
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className="flex-1 text-sm px-2 py-1 rounded border border-[var(--mui-palette-divider)] bg-transparent outline-none focus:border-[var(--mui-palette-primary-main)]"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleSave}
                  className="p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-green-500"
                  aria-label="Save"
                >
                  <Check size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {details.githubRepo ? (
                  <a
                    href={details.githubRepo.startsWith('http') ? details.githubRepo : `https://github.com/${details.githubRepo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[var(--mui-palette-primary-main)] hover:underline flex items-center gap-1"
                  >
                    {details.githubRepo}
                    <ExternalLink size={12} />
                  </a>
                ) : (
                  <span className="text-sm text-[var(--mui-palette-text-disabled)]">Not linked</span>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                  aria-label="Edit GitHub repo"
                >
                  <Pencil size={12} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <UpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
        mode="container"
        containerId={containerId}
        host={host}
        containerName={containerName}
      />
    </section>
  );
}

function PortsSection({ ports }: { ports: ContainerDetails['ports'] }) {
  if (ports.length === 0) {
    return (
      <section>
        <SectionHeading>Ports</SectionHeading>
        <p className="text-sm text-[var(--mui-palette-text-disabled)]">No port mappings</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Ports</SectionHeading>
      <div className="rounded-lg border border-[var(--mui-palette-divider)] overflow-hidden">
        <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--mui-palette-text-secondary)] bg-[var(--mui-palette-action-hover)]">
          <span>Host</span>
          <span>Container</span>
          <span>Protocol</span>
        </div>
        {ports.map((port, i) => (
          <div key={i} className="grid grid-cols-3 gap-2 px-3 py-1.5 text-sm border-t border-[var(--mui-palette-divider)]">
            <span>{port.hostIp}:{port.hostPort ?? '-'}</span>
            <span>{port.containerPort}</span>
            <span className="uppercase text-xs">{port.protocol}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function VolumesSection({ volumes }: { volumes: ContainerDetails['volumes'] }) {
  if (volumes.length === 0) {
    return (
      <section>
        <SectionHeading>Volumes</SectionHeading>
        <p className="text-sm text-[var(--mui-palette-text-disabled)]">No volumes mounted</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Volumes</SectionHeading>
      <div className="rounded-lg border border-[var(--mui-palette-divider)] overflow-hidden">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--mui-palette-text-secondary)] bg-[var(--mui-palette-action-hover)]">
          <span>Source</span>
          <span>Destination</span>
          <span>Mode</span>
        </div>
        {volumes.map((vol, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 px-3 py-1.5 text-sm border-t border-[var(--mui-palette-divider)]">
            <span className="truncate" title={vol.source}>{vol.source}</span>
            <span className="truncate" title={vol.destination}>{vol.destination}</span>
            <span className="text-xs">{vol.rw ? 'rw' : 'ro'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChangelogSection({ changelog, isLoading }: { changelog: GitHubRelease[]; isLoading: boolean }) {
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((tag: string) => {
    setExpandedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <section>
        <SectionHeading>Changelog</SectionHeading>
        <div className="flex justify-center py-4">
          <CircularProgress size={20} />
        </div>
      </section>
    );
  }

  if (changelog.length === 0) {
    return (
      <section>
        <SectionHeading>Changelog</SectionHeading>
        <p className="text-sm text-[var(--mui-palette-text-disabled)]">
          No changelog available. Link a GitHub repo to see release notes.
        </p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Changelog</SectionHeading>
      <div className="flex flex-col gap-2">
        {changelog.map((release) => {
          const isExpanded = expandedTags.has(release.tag);
          const publishDate = new Date(release.published_at).toLocaleDateString();

          return (
            <div
              key={release.tag}
              className="rounded-lg border border-[var(--mui-palette-divider)] overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleExpanded(release.tag)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--mui-palette-action-hover)] transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-[var(--mui-palette-action-hover)] px-1.5 py-0.5 rounded font-semibold">
                    {release.tag}
                  </code>
                  <span className="text-sm truncate">{release.name !== release.tag ? release.name : ''}</span>
                </div>
                <span className="text-xs text-[var(--mui-palette-text-secondary)] flex-shrink-0 ml-2">
                  {publishDate}
                </span>
              </button>
              {isExpanded && release.body && (
                <div className="px-3 py-2 border-t border-[var(--mui-palette-divider)] text-sm">
                  <pre className="whitespace-pre-wrap font-sans text-[var(--mui-palette-text-secondary)] max-h-[300px] overflow-y-auto">
                    {release.body}
                  </pre>
                  {release.url && (
                    <a
                      href={release.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-xs text-[var(--mui-palette-primary-main)] hover:underline"
                    >
                      View on GitHub <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
