import { describe, it, expect } from 'bun:test';
import { buildFileTree } from '../git-server-functions';

describe('buildFileTree', () => {
  it('should build a tree from flat file paths', () => {
    const files = [
      'manifest.yaml',
      'plex/docker-compose.yml',
      'traefik/docker-compose.yml',
      'traefik/config/traefik.yml',
    ];

    const tree = buildFileTree(files);

    expect(tree).toHaveLength(3);

    const manifest = tree.find((n) => n.name === 'manifest.yaml');
    expect(manifest).toBeDefined();
    expect(manifest!.type).toBe('file');

    const plex = tree.find((n) => n.name === 'plex');
    expect(plex).toBeDefined();
    expect(plex!.type).toBe('directory');
    expect(plex!.children).toHaveLength(1);

    const traefik = tree.find((n) => n.name === 'traefik');
    expect(traefik).toBeDefined();
    expect(traefik!.children).toHaveLength(2);
  });

  it('should sort directories before files', () => {
    const files = ['b.txt', 'a/c.txt'];
    const tree = buildFileTree(files);
    expect(tree[0].name).toBe('a');
    expect(tree[1].name).toBe('b.txt');
  });

  it('should handle empty file list', () => {
    const tree = buildFileTree([]);
    expect(tree).toEqual([]);
  });

  it('should filter out malformed path segments', () => {
    const files = ['', '../etc/passwd', 'a//b.txt', './c.txt'];
    const tree = buildFileTree(files);

    // '' is skipped entirely (no segments after filter)
    // '../etc/passwd' becomes ['etc', 'passwd']
    // 'a//b.txt' becomes ['a', 'b.txt']
    // './c.txt' becomes ['c.txt']
    const names = tree.map((n) => n.name);
    expect(names).not.toContain('..');
    expect(names).not.toContain('.');
    expect(names).not.toContain('');

    const aDir = tree.find((n) => n.name === 'a');
    expect(aDir).toBeDefined();
    expect(aDir!.children[0].name).toBe('b.txt');

    const cFile = tree.find((n) => n.name === 'c.txt');
    expect(cFile).toBeDefined();
  });
});
