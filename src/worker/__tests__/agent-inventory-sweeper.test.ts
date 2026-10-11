import { describe, it, expect, mock } from 'bun:test';
import { AgentInventorySweeper } from '../agent-inventory-sweeper';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';

function entry(id: number): AgentInventoryEntry {
  return {
    id,
    name: `host-${id}`,
    agentUrl: `http://host-${id}:9090`,
    capabilities: {},
    status: 'online',
    version: '0.1.0',
    versionSource: 'stored',
    agentImage: null,
    agentImageTag: null,
    lastError: null,
    checkedAt: new Date().toISOString(),
  };
}

describe('AgentInventorySweeper', () => {
  it('sweepOnce sweeps once and notifies once', async () => {
    const sweep = mock(() => Promise.resolve([entry(1)]));
    const notifySweep = mock(() => Promise.resolve());
    const sweeper = new AgentInventorySweeper({ sweep, notifySweep });

    await sweeper.sweepOnce();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(notifySweep).toHaveBeenCalledTimes(1);
  });

  it('the run loop continues after a failed sweep and stops on abort', async () => {
    let calls = 0;
    const sweeper = new AgentInventorySweeper({
      sweep: () => {
        calls += 1;
        if (calls >= 2) sweeper.stop();
        if (calls === 1) return Promise.reject(new Error('sweep boom'));
        return Promise.resolve([entry(1)]);
      },
      notifySweep: () => Promise.resolve(),
      intervalMs: 1,
    });

    await sweeper.run();

    expect(calls).toBe(2);
  });

  it('a failing notifySweep does not crash the loop', async () => {
    let notifies = 0;
    const sweeper = new AgentInventorySweeper({
      sweep: () => Promise.resolve([entry(1)]),
      notifySweep: () => {
        notifies += 1;
        if (notifies >= 2) sweeper.stop();
        if (notifies === 1) return Promise.reject(new Error('notify boom'));
        return Promise.resolve();
      },
      intervalMs: 1,
    });

    await sweeper.run();

    expect(notifies).toBe(2);
  });
});
