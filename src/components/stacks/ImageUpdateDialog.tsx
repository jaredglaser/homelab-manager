import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import Markdown from '@/components/shared/Markdown';
import { isSafeHttpUrl } from '@/lib/url-safety';
import { checkImageUpdates, getImageChangelog } from '@/data/stacks/functions';
import { IMAGE_CHANGELOG_QUERY_KEY, IMAGE_UPDATE_INFO_QUERY_KEY } from '@/lib/constants/stacks-keys';
import { constraintFromTag, matchesConstraint, normalizeVersion } from '@/lib/image-updates/version';
import type { ImageUpdateSummary } from '@/types/image-updates';
import type { StackContainer } from '@/types/stacks';

/** Human "checked N ago" text. The injected now keeps tests deterministic. */
export function relativeCheckedAt(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86400), 'day');
}

interface ImageUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  stackName: string;
  host: string;
  container: StackContainer;
  summary: ImageUpdateSummary | null;
}

type ReleaseView = 'matching' | 'all';

function tagOfImage(image: string): string | null {
  if (image.includes('@')) return null;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(colon + 1) : null;
}

function imageWithoutTag(image: string): string {
  const at = image.indexOf('@');
  if (at !== -1) return image.slice(0, at);
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(0, colon) : image;
}

function StatusBadge({ summary, currentTag, image }: { summary: ImageUpdateSummary | null; currentTag: string | null; image: string }) {
  let label: string;
  let className: string;
  if (summary?.error) {
    label = 'Check failed';
    className = 'text-warning bg-warning/10';
  } else if (summary?.updateAvailable === true) {
    // Floating tags have no matching version to name. The update is a re-pull.
    label = summary.latestMatchingTag ? `Update available: ${summary.latestMatchingTag}` : 'Update available';
    className = 'text-success bg-success/10';
  } else if (summary === null || summary.updateAvailable === null) {
    // A digest ref has no tag at all. A tagless ref (nginx) is Docker's
    // implicit latest, not a digest pin.
    label = currentTag === null
      ? (image.includes('@') ? 'Digest pin' : 'Floating tag (implicit latest)')
      : constraintFromTag(currentTag) === null ? `Floating tag (${currentTag})` : 'No version info';
    className = 'text-muted-foreground bg-level1';
  } else {
    label = 'Up to date';
    className = 'text-muted-foreground bg-level1';
  }
  return (
    <>
      {summary?.currentVersion && summary.versionSource !== 'tag' && (
        <span className="text-xs font-normal rounded px-1.5 py-0.5 shrink-0 text-muted-foreground bg-level1">
          Current: {summary.currentVersion}
        </span>
      )}
      {summary?.versionSource === 'tag' && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={0} aria-label="Why the version is unknown" className="text-xs font-normal rounded px-1.5 py-0.5 shrink-0 text-warning bg-warning/10 inline-flex items-center gap-1 cursor-help" />}
            >
              Version unknown
              <CircleHelp size={12} className="shrink-0" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              This image doesn't say which version it is. The check guessed from the tag name, so it may show an update you
              already have. Nothing is broken. Pinning a full version tag, like 2.11.7, makes this exact.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <span className={`text-xs font-normal rounded px-1.5 py-0.5 shrink-0 ${className}`}>
        {label}
      </span>
    </>
  );
}

export default function ImageUpdateDialog({
  open,
  onClose,
  stackName,
  host,
  container,
  summary,
}: ImageUpdateDialogProps) {
  const currentTag = summary?.currentTag ?? tagOfImage(container.image);
  const constraint = currentTag !== null ? constraintFromTag(currentTag) : null;
  const [view, setView] = useState<ReleaseView | null>(null);
  const effectiveView: ReleaseView = view ?? (constraint ? 'matching' : 'all');

  const { data: changelog, isLoading, isError } = useQuery({
    queryKey: [...IMAGE_CHANGELOG_QUERY_KEY, host, stackName, container.image],
    queryFn: () => getImageChangelog({ data: { stack: stackName, host, image: container.image } }),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  // Per-image re-check: runs the same check-and-persist path as the scheduled
  // refresher, then invalidates the panel query so this summary prop (and every
  // other client's panel) carries the fresh verdict.
  const queryClient = useQueryClient();
  const recheckMutation = useMutation({
    mutationFn: () =>
      checkImageUpdates({ data: { stack: stackName, host, image: container.image } }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [...IMAGE_UPDATE_INFO_QUERY_KEY, host, stackName] });
      if (result.failed > 0) {
        toast.warning(`Registry check failed for ${container.image}. The panel keeps the last known state.`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const releases = changelog?.releases ?? [];
  // The Docker variant selects an image build, so it cannot match upstream
  // release tags; dropped from BOTH sides (some repos publish v2.11.7-alpine
  // release tags, others v2.11.7).
  const releaseConstraint = constraint !== null ? { ...constraint, variant: null } : null;
  const visibleReleases =
    releaseConstraint !== null && effectiveView === 'matching'
      ? releases.filter((release) => {
          const parsed = normalizeVersion(release.tagName);
          return parsed !== null && matchesConstraint({ ...parsed, variant: null }, releaseConstraint);
        })
      : releases;

  // The footer names a version only when the check confirms an update exists.
  // Otherwise it stays versionless so it cannot contradict the badge above it,
  // and never offers the out-of-constraint latestOverallTag.
  const imageBase = imageWithoutTag(container.image);
  const updateAvailable = summary?.updateAvailable === true;
  // Hyphenated tokens (image names, tags like 2.11.7-alpine) must not split at
  // the hyphen when the footer wraps, so each one renders as an unbreakable span.
  const unbreakable = (value: string): ReactNode => <span className="whitespace-nowrap">{value}</span>;
  const footerText: ReactNode = summary === null || summary.updateAvailable === null
    ? currentTag === null
      ? <>The registry check can't compare versions for a digest pin. "Update images" re-pulls the newest published build of {unbreakable(imageBase)}.</>
      : summary?.error
        ? <>The last registry check failed, so this panel can't tell whether an update exists. Use "Re-check" to try again; "Update images" re-pulls the image either way.</>
        : <>The registry check hasn't finished comparing versions yet. "Update images" re-pulls the newest published build of {unbreakable(imageBase)}.</>
    : summary.updateAvailable === false
      ? constraint !== null
        ? `You're on the newest version matching your tag.`
        : <>You're on the newest published build of {unbreakable(imageBase)}.</>
      : constraint === null && currentTag !== null
        ? <>Click "Update images" in the stack action bar to pull the newest {unbreakable(currentTag)} build of {unbreakable(imageBase)}.</>
        : updateAvailable && summary.latestMatchingTag
          ? <>Click "Update images" in the stack action bar to update {unbreakable(imageBase)} to {unbreakable(summary.latestMatchingTag)}.</>
          : <>Click "Update images" in the stack action bar to update {unbreakable(imageBase)} to the newest published version.</>;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-5xl">
        <DialogTitle className="flex items-center gap-2 py-3 text-sm font-medium min-w-0">
          <span className="font-mono truncate min-w-0">{container.image}</span>
          <StatusBadge summary={summary} currentTag={currentTag} image={container.image} />
        </DialogTitle>
        <DialogBody>
          {constraint !== null && (
            <div className="flex items-center gap-1 mb-2">
              <Button
                variant={effectiveView === 'matching' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setView('matching')}
              >
                Matching {currentTag}
              </Button>
              <Button
                variant={effectiveView === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setView('all')}
              >
                All releases
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : changelog?.error ? (
            <div className="py-4">
              <p className="text-sm">{changelog.error}</p>
              {changelog.sourceRepo && (
                <p className="text-sm text-muted-foreground mt-1">
                  Source repository: {changelog.sourceRepo}
                </p>
              )}
            </div>
          ) : isError ? (
            <p className="text-sm text-warning py-4">Failed to load release notes.</p>
          ) : visibleReleases.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              {releases.length === 0
                ? (changelog?.emptyStateMessage ?? 'No releases published')
                : `No releases match your tag (${currentTag}). Switch to "All releases" to view every release.`}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleReleases.map((release, index) => (
                <li key={release.tagName} className="border border-border rounded overflow-hidden">
                  <Collapsible defaultOpen={index === 0}>
                    <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                      <ChevronRight
                        size={14}
                        className="transition-transform duration-200 shrink-0 group-data-open:rotate-90"
                      />
                      <span className="font-mono text-xs">{release.tagName}</span>
                      {release.prerelease && (
                        <span className="text-[10px] rounded bg-level1 px-1 py-0.5 text-muted-foreground">
                          Pre-release
                        </span>
                      )}
                      {release.publishedAt && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {new Date(release.publishedAt).toLocaleDateString()}
                        </span>
                      )}
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="px-3 pb-3 pt-2 border-t border-border">
                        {release.name && release.name !== release.tagName && (
                          <p className="text-sm font-medium mb-1">{release.name}</p>
                        )}
                        {release.body && <Markdown source={release.body} />}
                        {release.url && isSafeHttpUrl(release.url) && (
                          <a
                            href={release.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-info underline underline-offset-2 mt-1 inline-block"
                          >
                            Release notes
                          </a>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter className="grid grid-cols-2 items-center gap-x-3 gap-y-1 sm:grid-cols-[1fr_auto_auto]">
          <p className="col-span-2 text-xs text-muted-foreground sm:col-span-1 sm:col-start-1 sm:row-start-1">{footerText}</p>
          <Button
            variant="ghost"
            className="col-start-1 row-start-3 text-foreground sm:col-start-2 sm:row-start-1 sm:row-span-2"
            disabled={recheckMutation.isPending}
            onClick={() => recheckMutation.mutate()}
          >
            {recheckMutation.isPending ? <Spinner className="size-3" /> : null}
            Re-check
          </Button>
          <p className="col-span-2 text-xs text-muted-foreground sm:col-span-1 sm:col-start-1 sm:row-start-2">
            {summary?.checkedAt ? `Last checked ${relativeCheckedAt(summary.checkedAt)}` : 'Not checked yet'}
          </p>
          <Button variant="ghost" className="col-start-2 row-start-3 text-foreground sm:col-start-3 sm:row-start-1 sm:row-span-2" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}