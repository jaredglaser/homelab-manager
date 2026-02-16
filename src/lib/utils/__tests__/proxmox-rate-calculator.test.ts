import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { ProxmoxRateCalculator } from '../proxmox-rate-calculator';
import type { ProxmoxRateInput } from '@/types/proxmox';

let calculator: ProxmoxRateCalculator;

function createInput(overrides: Partial<ProxmoxRateInput> = {}): ProxmoxRateInput {
  return {
    id: 'pve1/qemu/100',
    cpu: 0.25,
    mem: 1024 * 1024 * 512,
    maxmem: 1024 * 1024 * 1024,
    disk: 1024 * 1024 * 1024 * 5,
    maxdisk: 1024 * 1024 * 1024 * 20,
    netin: 1024 * 1024 * 100,
    netout: 1024 * 1024 * 50,
    diskread: 1024 * 1024 * 200,
    diskwrite: 1024 * 1024 * 100,
    uptime: 86400,
    ...overrides,
  };
}

describe('ProxmoxRateCalculator.calculate', () => {
  beforeEach(() => {
    calculator = new ProxmoxRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should calculate CPU percentage from 0-1 fraction', () => {
    const input = createInput({ cpu: 0.75 });
    const result = calculator.calculate('test', input);

    expect(result.rates.cpuPercent).toBeCloseTo(75, 1);
  });

  it('should calculate memory percentage correctly', () => {
    const input = createInput({
      mem: 512 * 1024 * 1024,
      maxmem: 1024 * 1024 * 1024,
    });
    const result = calculator.calculate('test', input);

    expect(result.rates.memoryPercent).toBeCloseTo(50, 1);
  });

  it('should handle zero maxmem without division by zero', () => {
    const input = createInput({ mem: 100, maxmem: 0 });
    const result = calculator.calculate('test', input);

    expect(result.rates.memoryPercent).toBe(0);
  });

  it('should return zero network rates on first call', () => {
    const input = createInput();
    const result = calculator.calculate('test', input);

    expect(result.rates.networkInBytesPerSec).toBe(0);
    expect(result.rates.networkOutBytesPerSec).toBe(0);
    expect(result.rates.diskReadBytesPerSec).toBe(0);
    expect(result.rates.diskWriteBytesPerSec).toBe(0);
  });

  it('should calculate network rates on subsequent calls', () => {
    const input1 = createInput({
      netin: 100 * 1024 * 1024,
      netout: 50 * 1024 * 1024,
    });
    calculator.calculate('test', input1);

    jest.advanceTimersByTime(1000);

    const input2 = createInput({
      netin: 110 * 1024 * 1024,
      netout: 55 * 1024 * 1024,
    });
    const result = calculator.calculate('test', input2);

    expect(result.rates.networkInBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(result.rates.networkOutBytesPerSec).toBeCloseTo(5 * 1024 * 1024, 0);
  });

  it('should calculate disk I/O rates on subsequent calls', () => {
    const input1 = createInput({
      diskread: 200 * 1024 * 1024,
      diskwrite: 100 * 1024 * 1024,
    });
    calculator.calculate('test', input1);

    jest.advanceTimersByTime(2000);

    const input2 = createInput({
      diskread: 220 * 1024 * 1024,
      diskwrite: 110 * 1024 * 1024,
    });
    const result = calculator.calculate('test', input2);

    expect(result.rates.diskReadBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(result.rates.diskWriteBytesPerSec).toBeCloseTo(5 * 1024 * 1024, 0);
  });

  it('should handle negative deltas gracefully (counter reset)', () => {
    const input1 = createInput({ netin: 100 * 1024 * 1024 });
    calculator.calculate('test', input1);

    jest.advanceTimersByTime(1000);

    const input2 = createInput({ netin: 10 * 1024 * 1024 });
    const result = calculator.calculate('test', input2);

    expect(result.rates.networkInBytesPerSec).toBe(0);
  });

  it('should track multiple entities independently', () => {
    const input1a = createInput({ netin: 100 * 1024 * 1024 });
    const input1b = createInput({ netin: 200 * 1024 * 1024 });

    calculator.calculate('vm1', input1a);
    calculator.calculate('vm2', input1b);

    jest.advanceTimersByTime(1000);

    const input2a = createInput({ netin: 110 * 1024 * 1024 });
    const input2b = createInput({ netin: 230 * 1024 * 1024 });

    const resultA = calculator.calculate('vm1', input2a);
    const resultB = calculator.calculate('vm2', input2b);

    expect(resultA.rates.networkInBytesPerSec).toBeCloseTo(10 * 1024 * 1024, 0);
    expect(resultB.rates.networkInBytesPerSec).toBeCloseTo(30 * 1024 * 1024, 0);
  });

  it('should preserve input fields in output', () => {
    const input = createInput({ uptime: 86400 });
    const result = calculator.calculate('test', input);

    expect(result.id).toBe(input.id);
    expect(result.cpu).toBe(input.cpu);
    expect(result.mem).toBe(input.mem);
    expect(result.maxmem).toBe(input.maxmem);
    expect(result.uptime).toBe(86400);
  });
});

describe('ProxmoxRateCalculator.clear', () => {
  beforeEach(() => {
    calculator = new ProxmoxRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should clear all cached data', () => {
    calculator.calculate('vm1', createInput());
    calculator.calculate('vm2', createInput());

    calculator.clear();

    jest.advanceTimersByTime(1000);

    const result = calculator.calculate('vm1', createInput({
      netin: 200 * 1024 * 1024,
    }));

    expect(result.rates.networkInBytesPerSec).toBe(0);
  });
});

describe('ProxmoxRateCalculator.remove', () => {
  beforeEach(() => {
    calculator = new ProxmoxRateCalculator();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should remove specific entry from cache', () => {
    calculator.calculate('vm1', createInput({ netin: 100 * 1024 * 1024 }));
    calculator.calculate('vm2', createInput({ netin: 100 * 1024 * 1024 }));

    calculator.remove('vm1');

    jest.advanceTimersByTime(1000);

    const result1 = calculator.calculate('vm1', createInput({ netin: 200 * 1024 * 1024 }));
    const result2 = calculator.calculate('vm2', createInput({ netin: 200 * 1024 * 1024 }));

    expect(result1.rates.networkInBytesPerSec).toBe(0);
    expect(result2.rates.networkInBytesPerSec).toBeGreaterThan(0);
  });
});
