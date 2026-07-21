import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '../repo';
import { handleInfoRefs, handleUploadPack, handleReceivePack, getHeadOid } from '../git-server';

describe('handleInfoRefs', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-server-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return info/refs for upload-pack service', async () => {
    await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const response = await handleInfoRefs(repoPath, 'git-upload-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-upload-pack-advertisement');
  });

  it('should return info/refs for receive-pack service', async () => {
    await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const response = await handleInfoRefs(repoPath, 'git-receive-pack');
    expect(response.status).toBe(200);

    const contentType = response.headers.get('Content-Type');
    expect(contentType).toBe('application/x-git-receive-pack-advertisement');
  });

  it('should return 400 for invalid service', async () => {
    const response = await handleInfoRefs(repoPath, 'invalid');
    expect(response.status).toBe(400);
  });

  it('should return 500 when git process fails', async () => {
    const response = await handleInfoRefs('/nonexistent/path', 'git-upload-pack');
    expect(response.status).toBe(500);
  });
});

describe('handleUploadPack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-upload-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return 500 for empty request body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleUploadPack(repoPath, body);
    expect(response.status).toBe(500);
  });

  it('should return 500 when git process exits with non-zero code', async () => {
    const flushPkt = new TextEncoder().encode('0000');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(flushPkt);
        controller.close();
      },
    });

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleUploadPack('/nonexistent/path', body);
    errorSpy.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal server error');
  });

  it('should return 200 with correct Content-Type on success', async () => {
    // A flush packet (0000) is a valid minimal git-upload-pack request
    const flushPkt = new TextEncoder().encode('0000');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(flushPkt);
        controller.close();
      },
    });

    const response = await handleUploadPack(repoPath, body);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-git-upload-pack-result');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });
});

describe('handleReceivePack', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-receive-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return 500 for empty request body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const { response } = await handleReceivePack(repoPath, body);
    expect(response.status).toBe(500);
  });

});

describe('request body size limit', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-size-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return 413 when request body exceeds MAX_GIT_BODY_SIZE', async () => {
    // Create a stream that produces more than 50 MB
    const chunkSize = 1024 * 1024; // 1 MB chunks
    const totalChunks = 52; // 52 MB total
    let sent = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < totalChunks) {
          controller.enqueue(new Uint8Array(chunkSize));
          sent++;
        } else {
          controller.close();
        }
      },
    });

    const { response } = await handleReceivePack(repoPath, body);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Payload too large');
  });
});

describe('getHeadOid', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-head-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null for empty repo with no commits', async () => {
    const oid = await getHeadOid(repoPath);
    expect(oid).toBeNull();
  });

  it('should return commit OID when HEAD exists', async () => {
    const commitSha = await commitFiles(repoPath, () => ({
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const oid = await getHeadOid(repoPath);
    expect(oid).toBe(commitSha);
  });

  it('should return null for non-existent repo path', async () => {
    const oid = await getHeadOid(join(testDir, 'nonexistent.git'));
    expect(oid).toBeNull();
  });

  it('should return null and log error for unexpected git errors', async () => {
    // Pass a file (not a directory) as gitdir to trigger an unexpected error
    const filePath = join(testDir, 'not-a-repo');
    await Bun.write(filePath, 'not a git repo');

    const oid = await getHeadOid(filePath);
    expect(oid).toBeNull();
  });

  it('should return null and log error when resolveRef throws an unexpected error', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const resolveRefSpy = spyOn(git, 'resolveRef').mockRejectedValue(
      new Error('Unexpected internal failure'),
    );

    const oid = await getHeadOid(repoPath);

    expect(oid).toBeNull();
    // Verify the unexpected error was logged (not swallowed silently)
    expect(errorSpy).toHaveBeenCalledWith(
      '[GitServer] Unexpected error resolving HEAD:',
      'Unexpected internal failure',
    );

    resolveRefSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
