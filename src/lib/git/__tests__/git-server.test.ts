import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { handleInfoRefs, handleUploadPack, handleReceivePack, getHeadOid } from '../git-server';

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

  it('should return 500 for empty request body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleUploadPack(repoPath, body);
    expect(response.status).toBe(500);
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

  it('should return 500 for empty request body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const response = await handleReceivePack(repoPath, body);
    expect(response.status).toBe(500);
  });
});

describe('request body size limit', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-size-'));
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

    const response = await handleReceivePack(repoPath, body);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Payload too large');
  });
});

describe('getHeadOid', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-head-'));
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
    const commitSha = await commitFiles(repoPath, {
      files: [{ path: 'test.txt', content: 'hello' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const oid = await getHeadOid(repoPath);
    expect(oid).toBe(commitSha);
  });

  it('should return null for non-existent repo path', async () => {
    const oid = await getHeadOid(join(testDir, 'nonexistent.git'));
    expect(oid).toBeNull();
  });
});
