import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import { sourceRepoFromLabels } from './registry-client';

export interface StackImageGroup {
  host: string;
  stack: string;
  image: string;
  labels: Record<string, string>;
  imageDigest: string | null;
}

/**
 * One entry per distinct (host, image). When several containers share an
 * image ref, the labels that carry a source repo win and the first non-null
 * digest is kept (pre-039 inventory rows carry null).
 */
export function groupStackContainersByImage(rows: DockerContainerEventUpsertRow[]): StackImageGroup[] {
  const byKey = new Map<string, StackImageGroup>();
  for (const row of rows) {
    if (row.composeProject === null) continue;
    const key = row.host + '/' + row.image;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        host: row.host,
        stack: row.composeProject,
        image: row.image,
        labels: row.labels,
        imageDigest: row.imageDigest,
      });
      continue;
    }
    if (!sourceRepoFromLabels(existing.labels) && sourceRepoFromLabels(row.labels)) {
      existing.labels = row.labels;
    }
    if (!existing.imageDigest && row.imageDigest) {
      existing.imageDigest = row.imageDigest;
    }
  }
  return Array.from(byKey.values());
}
