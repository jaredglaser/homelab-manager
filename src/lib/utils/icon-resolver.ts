import { AVAILABLE_ICONS } from './available-icons';

// Re-export for convenience
export { AVAILABLE_ICONS, type IconSlug } from './available-icons';

/** Local icons path (served from public/icons/) */
const ICONS_PATH = '/icons';

/** Set for O(1) lookup */
const ICON_SET = new Set<string>(AVAILABLE_ICONS);

/**
 * Extract the base image name from a Docker image string.
 * Examples:
 *   "nginx:latest" → "nginx"
 *   "ghcr.io/immich-app/immich-server:release" → "immich"
 *   "lscr.io/linuxserver/plex:latest" → "plex"
 */
export function extractImageBaseName(image: string): string {
  // Remove tag
  const withoutTag = image.split(':')[0];

  // Get last path segment
  const segments = withoutTag.split('/');
  const lastSegment = segments[segments.length - 1];

  // Handle common patterns like "immich-server" → "immich"
  // or "linuxserver-plex" → "plex"
  const baseName = lastSegment
    .replace(/-server$/, '')
    .replace(/-app$/, '')
    .replace(/^linuxserver-/, '');

  return baseName.toLowerCase();
}

/**
 * Check if an icon exists in our local bundle
 */
export function hasIcon(slug: string): boolean {
  return ICON_SET.has(slug);
}

/**
 * Find an icon that contains the given term.
 * Returns the first match or null if none found.
 */
export function findIconContaining(term: string): string | null {
  if (!term) return null;
  const lowerTerm = term.toLowerCase();
  for (const icon of AVAILABLE_ICONS) {
    if (icon.includes(lowerTerm)) {
      return icon;
    }
  }
  return null;
}

/**
 * Resolve icon URL for a container.
 * Priority: user-selected icon > exact match > contains match > fallback
 */
export function getIconUrl(icon: string | null, image: string): string {
  // User-selected icon takes priority
  if (icon && hasIcon(icon)) {
    return `${ICONS_PATH}/${icon}.svg`;
  }

  const baseName = extractImageBaseName(image);

  // Try exact match first
  if (hasIcon(baseName)) {
    return `${ICONS_PATH}/${baseName}.svg`;
  }

  // Try contains match as fallback
  const containsMatch = findIconContaining(baseName);
  if (containsMatch) {
    return `${ICONS_PATH}/${containsMatch}.svg`;
  }

  // Fallback to docker icon
  return FALLBACK_ICON_URL;
}

/** Fallback icon URL (generic container) */
export const FALLBACK_ICON_URL = `${ICONS_PATH}/docker.svg`;
