import { describe, it, expect } from 'bun:test';
import {
  extractImageBaseName,
  hasIcon,
  findIconContaining,
  getIconUrl,
  FALLBACK_ICON_URL,
  AVAILABLE_ICONS,
} from '@/lib/utils/icon-resolver';

/**
 * BASE_URL (and therefore the icons path prefix) is environment-dependent, so
 * derive the live prefix from FALLBACK_ICON_URL rather than hardcoding it.
 */
const ICONS_PATH = FALLBACK_ICON_URL.replace(/\/docker\.svg$/, '');

describe('extractImageBaseName', () => {
  it('strips the tag', () => {
    expect(extractImageBaseName('nginx:latest')).toBe('nginx');
  });

  it('keeps the bare image name when there is no tag', () => {
    expect(extractImageBaseName('nginx')).toBe('nginx');
  });

  it('uses only the last path segment of a registry path', () => {
    expect(extractImageBaseName('lscr.io/linuxserver/plex:latest')).toBe('plex');
  });

  it('strips a -server suffix', () => {
    expect(extractImageBaseName('ghcr.io/immich-app/immich-server:release')).toBe('immich');
  });

  it('strips a -app suffix', () => {
    expect(extractImageBaseName('something-app:tag')).toBe('something');
  });

  it('strips a leading linuxserver- prefix', () => {
    expect(extractImageBaseName('linuxserver-plex')).toBe('plex');
  });

  it('lowercases the result', () => {
    expect(extractImageBaseName('NGINX:Latest')).toBe('nginx');
  });

  it('returns an empty string for empty input', () => {
    expect(extractImageBaseName('')).toBe('');
  });
});

describe('hasIcon', () => {
  it('returns true for a slug present in the bundle', () => {
    expect(hasIcon('nginx')).toBe(true);
  });

  it('returns false for a slug not in the bundle', () => {
    expect(hasIcon('zzznotanicon')).toBe(false);
  });

  it('returns false for an empty slug', () => {
    expect(hasIcon('')).toBe(false);
  });
});

describe('findIconContaining', () => {
  it('returns null for an empty term', () => {
    expect(findIconContaining('')).toBeNull();
  });

  it('returns an exact match when present', () => {
    expect(findIconContaining('nginx')).toBe('nginx');
  });

  it('returns the first icon that contains the term', () => {
    // "mich" has no exact slug but is a substring of "immich".
    expect(findIconContaining('mich')).toBe('immich');
  });

  it('lowercases the term before matching', () => {
    expect(findIconContaining('NGINX')).toBe('nginx');
  });

  it('returns null when no icon contains the term', () => {
    expect(findIconContaining('zzznotanicon')).toBeNull();
  });
});

describe('getIconUrl', () => {
  it('uses a valid user-selected icon ahead of everything else', () => {
    // image would resolve to nginx, but the explicit icon wins.
    expect(getIconUrl('plex', 'nginx:latest')).toBe(`${ICONS_PATH}/plex.svg`);
  });

  it('ignores an invalid user-selected icon and falls back to image matching', () => {
    expect(getIconUrl('zzznotanicon', 'nginx:latest')).toBe(`${ICONS_PATH}/nginx.svg`);
  });

  it('falls back to image matching when icon is null', () => {
    expect(getIconUrl(null, 'nginx:latest')).toBe(`${ICONS_PATH}/nginx.svg`);
  });

  it('resolves via an exact image base-name match', () => {
    expect(getIconUrl(null, 'ghcr.io/immich-app/immich-server:release')).toBe(
      `${ICONS_PATH}/immich.svg`,
    );
  });

  it('resolves via a contains match when there is no exact match', () => {
    // "mich" has no exact icon but is contained by "immich".
    expect(getIconUrl(null, 'mich:latest')).toBe(`${ICONS_PATH}/immich.svg`);
  });

  it('returns the fallback icon when nothing matches', () => {
    expect(getIconUrl(null, 'zzznotanicon:latest')).toBe(FALLBACK_ICON_URL);
  });
});

describe('module re-exports', () => {
  it('re-exports AVAILABLE_ICONS', () => {
    expect(Array.isArray(AVAILABLE_ICONS)).toBe(true);
    expect(AVAILABLE_ICONS.length).toBeGreaterThan(0);
  });

  it('exposes a fallback icon url ending in docker.svg', () => {
    expect(FALLBACK_ICON_URL.endsWith('/docker.svg')).toBe(true);
  });
});
