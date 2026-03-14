import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from '../git-server';

describe('handleInfoRefs', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-server-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return info/refs for upload-pack service', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const response = await handleInfoRefs(repoPath, 'git-upload-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-upload-pack-advertisement');
  });

  it('should return info/refs for receive-pack service', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const response = await handleInfoRefs(repoPath, 'git-receive-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-receive-pack-advertisement');
  });

  it('should return 400 for invalid service', async () => {
    const response = await handleInfoRefs(repoPath, 'invalid');
    expect(response.status).toBe(400);
  });
});

describe('handleUploadPack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-upload-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return correct content type', async () => {
    // Create a minimal upload-pack request body
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleUploadPack(repoPath, body);
    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-upload-pack-result');
  });
});

describe('handleReceivePack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-receive-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return correct content type', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleReceivePack(repoPath, body);
    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-receive-pack-result');
  });
});
