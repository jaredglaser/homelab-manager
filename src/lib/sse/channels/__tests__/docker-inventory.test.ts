import { describe, it, expect } from 'bun:test';
import { dockerInventoryChannel } from '../docker-inventory';

const snapshotContainer = {
  host: 'server1',
  containerId: 'abc123',
  name: 'plex',
  image: 'plexinc/pms-docker:latest',
  state: 'running',
  composeProject: 'media',
  serviceKey: 'media/plex',
  startedAt: '2026-04-16T10:00:00.000Z',
  finishedAt: null,
  exitCode: null,
  labels: { 'com.docker.compose.project': 'media' },
  updatedAt: '2026-04-16T10:00:00.000Z',
};

describe('dockerInventoryChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(dockerInventoryChannel.url).toBe('/api/docker-inventory');
    expect(dockerInventoryChannel.errorEvent).toBe('inventory_error');
  });

  it('validates a well-formed init frame', () => {
    const result = dockerInventoryChannel.schema.safeParse({
      type: 'init',
      containers: [snapshotContainer],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a frame missing required fields', () => {
    const result = dockerInventoryChannel.schema.safeParse({ type: 'init', containers: [{ host: 'server1' }] });
    expect(result.success).toBe(false);
  });

  it('revives startedAt/finishedAt/updatedAt to Date objects on init', () => {
    const parsed = dockerInventoryChannel.schema.parse({ type: 'init', containers: [snapshotContainer] });
    const revived = dockerInventoryChannel.revive!(parsed);

    expect(revived.type).toBe('init');
    if (revived.type !== 'init') throw new Error('expected init');
    const container = revived.containers[0];
    expect(container.startedAt).toBeInstanceOf(Date);
    expect(container.startedAt!.getTime()).toBe(Date.parse('2026-04-16T10:00:00.000Z'));
    expect(container.finishedAt).toBeNull();
    expect(container.updatedAt).toBeInstanceOf(Date);
  });

  it('revives dates on upsert', () => {
    const { labels: _labels, ...updateContainer } = snapshotContainer;
    const parsed = dockerInventoryChannel.schema.parse({ type: 'upsert', container: updateContainer });
    const revived = dockerInventoryChannel.revive!(parsed);

    expect(revived.type).toBe('upsert');
    if (revived.type !== 'upsert') throw new Error('expected upsert');
    expect(revived.container.startedAt).toBeInstanceOf(Date);
    expect(revived.container.updatedAt).toBeInstanceOf(Date);
  });

  it('revives the at field on destroy', () => {
    const parsed = dockerInventoryChannel.schema.parse({
      type: 'destroy',
      host: 'server1',
      containerId: 'abc123',
      at: '2026-04-16T11:00:00.000Z',
    });
    const revived = dockerInventoryChannel.revive!(parsed);

    expect(revived.type).toBe('destroy');
    if (revived.type !== 'destroy') throw new Error('expected destroy');
    expect(revived.at).toBeInstanceOf(Date);
    expect(revived.at.getTime()).toBe(Date.parse('2026-04-16T11:00:00.000Z'));
  });
});
