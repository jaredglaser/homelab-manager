import type { ContainerVersionSummary, GitHubRelease } from '@/types/container-versions';

export const MOCK_CONTAINER_VERSIONS: ContainerVersionSummary[] = [
  { image: 'nginx:latest', current_tag: 'latest', latest_tag: '1.27.3', update_available: true, github_repo: 'nginx/nginx', github_repo_source: 'oci_label' },
  { image: 'plexinc/pms-docker:latest', current_tag: 'latest', latest_tag: '1.41.3.9314', update_available: true, github_repo: 'plexinc/pms-docker', github_repo_source: 'oci_label' },
  { image: 'homeassistant/home-assistant:stable', current_tag: 'stable', latest_tag: '2025.3.1', update_available: false, github_repo: 'home-assistant/core', github_repo_source: 'oci_label' },
  { image: 'timescale/timescaledb:latest-pg16', current_tag: 'latest-pg16', latest_tag: '2.18.1-pg16', update_available: false, github_repo: 'timescale/timescaledb', github_repo_source: 'oci_label' },
  { image: 'grafana/grafana:latest', current_tag: 'latest', latest_tag: '11.5.2', update_available: true, github_repo: 'grafana/grafana', github_repo_source: 'oci_label' },
  { image: 'traefik:v3', current_tag: 'v3', latest_tag: 'v3.3.3', update_available: false, github_repo: 'traefik/traefik', github_repo_source: 'oci_label' },
  { image: 'jellyfin/jellyfin:latest', current_tag: 'latest', latest_tag: '10.10.6', update_available: false, github_repo: 'jellyfin/jellyfin', github_repo_source: 'oci_label' },
  { image: 'vaultwarden/server:latest', current_tag: 'latest', latest_tag: '1.33.2', update_available: true, github_repo: 'dani-garcia/vaultwarden', github_repo_source: 'oci_label' },
  { image: 'pihole/pihole:latest', current_tag: 'latest', latest_tag: '2025.02.1', update_available: false, github_repo: 'pi-hole/pi-hole', github_repo_source: 'oci_label' },
  { image: 'portainer/portainer-ce:latest', current_tag: 'latest', latest_tag: '2.25.1', update_available: false, github_repo: 'portainer/portainer', github_repo_source: 'oci_label' },
];

const sampleChangelog: GitHubRelease[] = [
  {
    tag: 'v1.27.3',
    name: 'Release v1.27.3',
    body: '## Changes\n- Fixed upstream security vulnerability CVE-2025-1234\n- Updated OpenSSL to 3.4.1\n- Performance improvements for HTTP/3\n\n## Bug Fixes\n- Fixed memory leak in upstream keepalive connections\n- Resolved issue with proxy_pass and IPv6 addresses',
    published_at: '2025-12-01T10:00:00Z',
    url: 'https://github.com/nginx/nginx/releases/tag/v1.27.3',
  },
  {
    tag: 'v1.27.2',
    name: 'Release v1.27.2',
    body: '## Changes\n- Added support for QUIC 0-RTT\n- Improved error logging for SSL handshake failures\n\n## Bug Fixes\n- Fixed worker process crash with certain regex patterns',
    published_at: '2025-10-15T10:00:00Z',
    url: 'https://github.com/nginx/nginx/releases/tag/v1.27.2',
  },
  {
    tag: 'v1.27.1',
    name: 'Release v1.27.1',
    body: '## Changes\n- Minor performance improvements\n- Updated bundled zlib\n\n## Bug Fixes\n- Fixed connection reset with HTTP/2 under high load',
    published_at: '2025-08-20T10:00:00Z',
    url: 'https://github.com/nginx/nginx/releases/tag/v1.27.1',
  },
];

export const MOCK_CONTAINER_CHANGELOGS: Record<string, GitHubRelease[]> = {
  'nginx:latest': sampleChangelog,
  'grafana/grafana:latest': [
    {
      tag: 'v11.5.2',
      name: 'Grafana v11.5.2',
      body: '## What\'s Changed\n- Fixed dashboard provisioning regression\n- Improved query editor performance\n- Security fix for authentication bypass',
      published_at: '2025-11-28T10:00:00Z',
      url: 'https://github.com/grafana/grafana/releases/tag/v11.5.2',
    },
  ],
  'vaultwarden/server:latest': [
    {
      tag: 'v1.33.2',
      name: 'v1.33.2',
      body: '## Changes\n- Updated web vault to v2025.1.1\n- Added support for passkey authentication\n- Fixed SMTP TLS negotiation issue',
      published_at: '2025-11-20T10:00:00Z',
      url: 'https://github.com/dani-garcia/vaultwarden/releases/tag/1.33.2',
    },
  ],
  'plexinc/pms-docker:latest': [
    {
      tag: 'v1.41.3.9314',
      name: 'Plex Media Server v1.41.3.9314',
      body: '## New Features\n- Improved hardware transcoding support\n- Better metadata matching for anime\n\n## Fixes\n- Fixed playback stuttering on 4K HDR content\n- Resolved library scan memory usage issue',
      published_at: '2025-11-25T10:00:00Z',
      url: 'https://github.com/plexinc/pms-docker/releases/tag/1.41.3.9314',
    },
  ],
};
