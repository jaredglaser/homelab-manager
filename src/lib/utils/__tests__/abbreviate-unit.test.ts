import { describe, it, expect } from 'bun:test';
import { abbreviateUnit } from '../abbreviate-unit';

describe('abbreviateUnit', () => {
  describe('percent', () => {
    it('keeps % unchanged', () => {
      expect(abbreviateUnit('%')).toBe('%');
    });
  });

  describe('bytes with /s (binary)', () => {
    it('keeps B/s unchanged', () => {
      expect(abbreviateUnit('B/s')).toBe('B/s');
    });

    it('abbreviates KiB/s to K/s', () => {
      expect(abbreviateUnit('KiB/s')).toBe('K/s');
    });

    it('abbreviates MiB/s to M/s', () => {
      expect(abbreviateUnit('MiB/s')).toBe('M/s');
    });

    it('abbreviates GiB/s to G/s', () => {
      expect(abbreviateUnit('GiB/s')).toBe('G/s');
    });

    it('abbreviates TiB/s to T/s', () => {
      expect(abbreviateUnit('TiB/s')).toBe('T/s');
    });
  });

  describe('bytes without /s (binary)', () => {
    it('keeps B unchanged', () => {
      expect(abbreviateUnit('B')).toBe('B');
    });

    it('abbreviates KiB to K', () => {
      expect(abbreviateUnit('KiB')).toBe('K');
    });

    it('abbreviates MiB to M', () => {
      expect(abbreviateUnit('MiB')).toBe('M');
    });

    it('abbreviates GiB to G', () => {
      expect(abbreviateUnit('GiB')).toBe('G');
    });

    it('abbreviates TiB to T', () => {
      expect(abbreviateUnit('TiB')).toBe('T');
    });
  });

  describe('bits (SI) with bps suffix', () => {
    it('abbreviates bps to b/s', () => {
      expect(abbreviateUnit('bps')).toBe('b/s');
    });

    it('abbreviates Kbps to K/s', () => {
      expect(abbreviateUnit('Kbps')).toBe('K/s');
    });

    it('abbreviates Mbps to M/s', () => {
      expect(abbreviateUnit('Mbps')).toBe('M/s');
    });

    it('abbreviates Gbps to G/s', () => {
      expect(abbreviateUnit('Gbps')).toBe('G/s');
    });
  });

  describe('unknown units', () => {
    it('returns unknown units unchanged', () => {
      expect(abbreviateUnit('unknown')).toBe('unknown');
    });

    it('returns empty string unchanged', () => {
      expect(abbreviateUnit('')).toBe('');
    });

    it('returns custom units unchanged', () => {
      expect(abbreviateUnit('ops/sec')).toBe('ops/sec');
    });
  });
});
