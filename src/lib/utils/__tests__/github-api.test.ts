import { describe, it, expect } from 'bun:test';
import { parseGitHubRepoUrl, extractGitHubRepo } from '../github-api';

describe('parseGitHubRepoUrl', () => {
  it('extracts owner/repo from HTTPS URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('handles trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr/')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('handles .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr.git')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepoUrl('https://gitlab.com/foo/bar')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(parseGitHubRepoUrl('')).toBeNull();
    expect(parseGitHubRepoUrl('not-a-url')).toBeNull();
  });

  it('handles URLs with extra path segments', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });
});

describe('extractGitHubRepo', () => {
  it('extracts from OCI source label', () => {
    const labels = { 'org.opencontainers.image.source': 'https://github.com/linuxserver/docker-sonarr' };
    expect(extractGitHubRepo(labels)).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('returns null when no relevant labels', () => {
    expect(extractGitHubRepo({})).toBeNull();
    expect(extractGitHubRepo({ 'com.docker.compose.service': 'web' })).toBeNull();
  });
});
