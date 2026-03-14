import { describe, it, expect } from 'bun:test';
import {
  parseGitPath,
  isGitInfoRefsRequest,
  isGitUploadPackRequest,
  isGitReceivePackRequest,
} from '../git-http';

describe('parseGitPath', () => {
  it('should parse info/refs path', () => {
    const result = parseGitPath('/api/git/stacks/info/refs');
    expect(result).toEqual({ repo: 'stacks', action: 'info/refs' });
  });

  it('should parse git-upload-pack path', () => {
    const result = parseGitPath('/api/git/stacks/git-upload-pack');
    expect(result).toEqual({ repo: 'stacks', action: 'git-upload-pack' });
  });

  it('should parse git-receive-pack path', () => {
    const result = parseGitPath('/api/git/stacks/git-receive-pack');
    expect(result).toEqual({ repo: 'stacks', action: 'git-receive-pack' });
  });

  it('should return null for invalid path', () => {
    const result = parseGitPath('/api/git/');
    expect(result).toBeNull();
  });

  it('should return null for unknown action', () => {
    const result = parseGitPath('/api/git/stacks/unknown');
    expect(result).toBeNull();
  });
});

describe('request type checks', () => {
  it('should identify info/refs GET request', () => {
    expect(isGitInfoRefsRequest('GET', 'info/refs')).toBe(true);
    expect(isGitInfoRefsRequest('POST', 'info/refs')).toBe(false);
  });

  it('should identify upload-pack POST request', () => {
    expect(isGitUploadPackRequest('POST', 'git-upload-pack')).toBe(true);
    expect(isGitUploadPackRequest('GET', 'git-upload-pack')).toBe(false);
  });

  it('should identify receive-pack POST request', () => {
    expect(isGitReceivePackRequest('POST', 'git-receive-pack')).toBe(true);
    expect(isGitReceivePackRequest('GET', 'git-receive-pack')).toBe(false);
  });
});
