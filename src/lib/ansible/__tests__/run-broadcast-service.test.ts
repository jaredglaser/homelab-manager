import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import {
  AnsibleRunBroadcastService,
  ansibleRunBroadcastService,
} from '@/lib/ansible/run-broadcast-service';

const finished = { type: 'run_finished', runId: 'run-1', status: 'succeeded' } as const;

describe('AnsibleRunBroadcastService', () => {
  afterEach(() => {
    mock.restore();
  });

  it('delivers to every subscriber and stops on unsubscribe', () => {
    const service = new AnsibleRunBroadcastService();
    const first = mock(() => {});
    const second = mock(() => {});

    const unsubscribe = service.subscribe(first);
    service.subscribe(second);
    expect(service.subscriberCount).toBe(2);

    service.publish(finished);
    unsubscribe();
    service.publish(finished);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(service.subscriberCount).toBe(1);
  });

  it('keeps delivering after a subscriber throws', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const service = new AnsibleRunBroadcastService();
    const healthy = mock(() => {});

    service.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    service.subscribe(healthy);
    service.publish(finished);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it('exports a shared instance', () => {
    expect(ansibleRunBroadcastService).toBeInstanceOf(AnsibleRunBroadcastService);
  });
});
