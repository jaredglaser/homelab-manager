import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import Markdown from '@/components/shared/Markdown';
import { isSafeHttpUrl } from '@/lib/url-safety';
import { getImageChangelog } from '@/data/stacks/functions';
import { IMAGE_CHANGELOG_QUERY_KEY } from '@/lib/constants/stacks-keys';
import { constraintFromTag, matchesConstraint, parseVersionTag } from '@/lib/image-updates/version';
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

function StatusBadge({
  summary,
  currentTag,
  image,
}: {
  summary: ImageUpdateSummary | null;
  currentTag: string | null;
  image: string;
}) {
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
    <span className={`text-xs font-normal rounded px-1.5 py-0.5 shrink-0 ${className}`}>
      {label}
    </span>
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

  const releases = changelog?.releases ?? [];
  const visibleReleases =
    constraint !== null && effectiveView === 'matching'
      ? releases.filter((release) => {
          const parsed = parseVersionTag(release.tagName);
          return parsed !== null && matchesConstraint(parsed, constraint);
        })
      : releases;

  // The footer names a version only when the check confirms an update exists.
  // Otherwise it stays versionless so it cannot contradict the badge above it,
  // and never offers the out-of-constraint latestOverallTag.
  const imageBase = imageWithoutTag(container.image);
  const updateAvailable = summary?.updateAvailable === true;
  const footerText = summary?.updateAvailable === false
    ? constraint !== null
      ? `You're on the newest version matching your tag.`
      : `You're on the newest published build of ${imageBase}.`
    : constraint === null && currentTag !== null
      ? `Click "Update images" in the stack action bar to pull the newest ${currentTag} build of ${imageBase}.`
      : updateAvailable && summary.latestMatchingTag
        ? `Click "Update images" in the stack action bar to update ${imageBase} to ${summary.latestMatchingTag}.`
        : `Click "Update images" in the stack action bar to update ${imageBase} to the newest published version.`;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-2xl">
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
                ? 'No releases published'
                : `No releases match your tag (${currentTag}). Switch to "All releases" to view every release.`}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visibleReleases.map((release) => (
                <li key={release.tagName} className="border border-border rounded p-3">
                  <div className="flex items-center gap-2">
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
                  </div>
                  {release.name && release.name !== release.tagName && (
                    <p className="text-sm font-medium mt-1">{release.name}</p>
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
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <p className="text-xs text-muted-foreground mr-auto">{footerText}</p>
          {summary?.checkedAt && (
            <p className="text-xs text-muted-foreground">Last checked {relativeCheckedAt(summary.checkedAt)}</p>
          )}
          <Button variant="ghost" className="text-foreground" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}