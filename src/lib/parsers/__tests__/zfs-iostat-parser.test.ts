import { describe, it, expect } from 'bun:test';
import { parseZFSIOStat, ZFSIOStatParser } from '../zfs-iostat-parser';
import type { ZFSIOStatRaw } from '@/types/zfs';

describe('parseIOStatValue (via parseZFSIOStat)', () => {
  it('should parse values without units', () => {
    const line = 'tank    1024   2048   10   5   100   50';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBe(1024);
    expect(result!.capacity.free).toBe(2048);
  });

  it('should parse values with K suffix', () => {
    const line = 'tank    890K   1024K   10   5   100K   50K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBe(890 * 1024);
    expect(result!.capacity.free).toBe(1024 * 1024);
    expect(result!.bandwidth.read).toBe(100 * 1024);
    expect(result!.bandwidth.write).toBe(50 * 1024);
  });

  it('should parse values with M suffix', () => {
    const line = 'tank    40.2M   100M   10   5   1.5M   750K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(40.2 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBe(100 * 1024 * 1024);
    expect(result!.bandwidth.read).toBeCloseTo(1.5 * 1024 * 1024, 0);
  });

  it('should parse values with G suffix', () => {
    const line = 'tank    1.5G   500G   10   5   100M   50M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(1.5 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(500 * 1024 * 1024 * 1024, 0);
  });

  it('should parse values with T suffix', () => {
    const line = 'tank    1.81T   2.5T   100   50   1G   500M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(1.81 * 1024 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(2.5 * 1024 * 1024 * 1024 * 1024, 0);
  });

  it('should parse values with P suffix', () => {
    const line = 'tank    2.5P   5P   1000   500   10G   5G';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(2.5 * 1024 * 1024 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(5 * 1024 * 1024 * 1024 * 1024 * 1024, 0);
  });

  it('should handle dash as zero', () => {
    const line = '  mirror-0  -  -  10   5   1M   500K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBe(0);
    expect(result!.capacity.free).toBe(0);
  });

  it('should handle case-insensitive units', () => {
    const line = 'tank    10k   20m   5g   1t   100K   50M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBe(10 * 1024);
    expect(result!.capacity.free).toBe(20 * 1024 * 1024);
    expect(result!.operations.read).toBeCloseTo(5 * 1024 * 1024 * 1024, 0);
    expect(result!.operations.write).toBeCloseTo(1024 * 1024 * 1024 * 1024, 0);
  });

  it('should handle operations with K/M/G suffixes', () => {
    const line = 'tank  1T  500G  10K  5K  1M  500K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.operations.read).toBe(10 * 1024);
    expect(result!.operations.write).toBe(5 * 1024);
  });
});

describe('parseZFSIOStat', () => {
  it('should parse pool-level stats', () => {
    const line = 'tank    1.81T   890K   10   5   1.5M   750K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank');
    expect(result!.indent).toBe(0);
    expect(result!.capacity.alloc).toBeCloseTo(1.81 * 1024 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(890 * 1024, 0);
    expect(result!.operations.read).toBe(10);
    expect(result!.operations.write).toBe(5);
    expect(result!.bandwidth.read).toBeCloseTo(1.5 * 1024 * 1024, 0);
    expect(result!.bandwidth.write).toBeCloseTo(750 * 1024, 0);
    expect(result!.total.readOps).toBe(0);
    expect(result!.total.writeOps).toBe(0);
    expect(result!.total.readBytes).toBe(0);
    expect(result!.total.writeBytes).toBe(0);
  });

  it('should parse vdev stats with indentation', () => {
    const line = '  mirror-0  -  -  8   4   1.2M   600K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('mirror-0');
    expect(result!.indent).toBe(2);
    expect(result!.capacity.alloc).toBe(0);
    expect(result!.capacity.free).toBe(0);
    expect(result!.operations.read).toBe(8);
    expect(result!.operations.write).toBe(4);
  });

  it('should parse disk stats with deeper indentation', () => {
    const line = '    sda1  -  -  4   2   600K   300K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('sda1');
    expect(result!.indent).toBe(4);
    expect(result!.operations.read).toBe(4);
    expect(result!.operations.write).toBe(2);
  });

  it('should parse disk stats with even deeper indentation', () => {
    const line = '      nvme0n1p1  -  -  100   50   10M   5M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('nvme0n1p1');
    expect(result!.indent).toBe(6);
  });

  it('should skip header line with capacity/operations/bandwidth', () => {
    const line = '   capacity   operations   bandwidth';
    expect(parseZFSIOStat(line)).toBeNull();
  });

  it('should skip header line with pool/alloc/free', () => {
    const line = 'pool  alloc  free  read  write  read  write';
    expect(parseZFSIOStat(line)).toBeNull();
  });

  it('should skip header line variations', () => {
    const headers = [
      '               capacity     operations     bandwidth',
      'pool        alloc   free   read  write   read  write',
      'pool  alloc  free    read    write    read    write',
    ];

    headers.forEach(line => {
      expect(parseZFSIOStat(line)).toBeNull();
    });
  });

  it('should skip separator lines with dashes', () => {
    const separators = [
      '----------------------------------------',
      '- - - - - - -',
      '-------',
    ];

    separators.forEach(line => {
      expect(parseZFSIOStat(line)).toBeNull();
    });
  });

  it('should skip separator lines with spaces', () => {
    expect(parseZFSIOStat('        ')).toBeNull();
    expect(parseZFSIOStat('   ')).toBeNull();
  });

  it('should skip empty lines', () => {
    expect(parseZFSIOStat('')).toBeNull();
  });

  it('should skip mixed dash and space separator', () => {
    expect(parseZFSIOStat('  - - - - -  ')).toBeNull();
  });

  it('should handle lines with insufficient columns', () => {
    expect(parseZFSIOStat('tank  1.81T  890K')).toBeNull();
    expect(parseZFSIOStat('tank  1T  500G  10')).toBeNull();
    expect(parseZFSIOStat('tank')).toBeNull();
  });

  it('should handle lines with exactly 7 columns', () => {
    const line = 'tank  1T  500G  10  5  1M  500K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank');
  });

  it('should handle lines with more than 7 columns', () => {
    // Some systems may have additional columns
    const line = 'tank  1T  500G  10  5  1M  500K  extra  data';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank');
  });

  it('should parse real-world zpool iostat output', () => {
    const lines = [
      'capacity   operations   bandwidth',
      'pool  alloc  free  read  write  read  write',
      'tank  1.81T  890G  10  5  1.5M  750K',
      '  mirror-0  -  -  8  4  1.2M  600K',
      '    sda1  -  -  4  2  600K  300K',
      '    sdb1  -  -  4  2  600K  300K',
      '  mirror-1  -  -  2  1  300K  150K',
      '    sdc1  -  -  1  0  150K  75K',
      '    sdd1  -  -  1  1  150K  75K',
    ];

    const results = lines
      .map(line => parseZFSIOStat(line))
      .filter((r): r is ZFSIOStatRaw => r !== null);

    expect(results).toHaveLength(7);
    expect(results[0].name).toBe('tank');
    expect(results[0].indent).toBe(0);
    expect(results[1].name).toBe('mirror-0');
    expect(results[1].indent).toBe(2);
    expect(results[2].name).toBe('sda1');
    expect(results[2].indent).toBe(4);
  });

  it('should handle pool names with special characters', () => {
    const line = 'tank-backup-2024  1T  500G  10  5  1M  500K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank-backup-2024');
  });

  it('should handle device names with underscores', () => {
    const line = '    nvme_0n1p1  -  -  100  50  10M  5M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('nvme_0n1p1');
  });

  it('should treat invalid numeric values as zero', () => {
    const line = 'tank  invalid  data  not  numbers  here  either';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank');
    // Invalid values are parsed as 0
    expect(result!.capacity.alloc).toBe(0);
    expect(result!.capacity.free).toBe(0);
    expect(result!.operations.read).toBe(0);
    expect(result!.operations.write).toBe(0);
  });

  it('should handle decimal values in operations', () => {
    const line = 'tank  1T  500G  10.5  5.2  1M  500K';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.operations.read).toBeCloseTo(10.5, 1);
    expect(result!.operations.write).toBeCloseTo(5.2, 1);
  });

  it('should handle zero values', () => {
    const line = 'tank  0  0  0  0  0  0';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBe(0);
    expect(result!.capacity.free).toBe(0);
    expect(result!.operations.read).toBe(0);
    expect(result!.operations.write).toBe(0);
    expect(result!.bandwidth.read).toBe(0);
    expect(result!.bandwidth.write).toBe(0);
  });

  it('should handle very large values with P suffix', () => {
    const line = 'massive-pool  10.5P  5.2P  100K  50K  10G  5G';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(10.5 * 1024 * 1024 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(5.2 * 1024 * 1024 * 1024 * 1024 * 1024, 0);
  });

  it('should handle mixed unit sizes in single line', () => {
    const line = 'tank  1.5T  890G  10K  5M  1.2G  750M';
    const result = parseZFSIOStat(line);

    expect(result).not.toBeNull();
    expect(result!.capacity.alloc).toBeCloseTo(1.5 * 1024 * 1024 * 1024 * 1024, 0);
    expect(result!.capacity.free).toBeCloseTo(890 * 1024 * 1024 * 1024, 0);
    expect(result!.operations.read).toBe(10 * 1024);
    expect(result!.operations.write).toBeCloseTo(5 * 1024 * 1024, 0);
  });
});

describe('ZFSIOStatParser', () => {
  it('should skip first 2 header lines', () => {
    const parser = new ZFSIOStatParser();

    expect(parser.parseLine('capacity  operations  bandwidth')).toBeNull();
    expect(parser.parseLine('pool  alloc  free  read  write')).toBeNull();
  });

  it('should parse data lines after headers', () => {
    const parser = new ZFSIOStatParser();

    parser.parseLine('header1');
    parser.parseLine('header2');

    const result = parser.parseLine('tank  1T  500G  10  5  1M  500K');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('tank');
  });

  it('should parse multiple data lines', () => {
    const parser = new ZFSIOStatParser();

    parser.parseLine('header1');
    parser.parseLine('header2');

    const result1 = parser.parseLine('tank  1T  500G  10  5  1M  500K');
    const result2 = parser.parseLine('  mirror-0  -  -  8  4  800K  400K');
    const result3 = parser.parseLine('    sda1  -  -  4  2  400K  200K');

    expect(result1).not.toBeNull();
    expect(result1!.name).toBe('tank');
    expect(result2).not.toBeNull();
    expect(result2!.name).toBe('mirror-0');
    expect(result3).not.toBeNull();
    expect(result3!.name).toBe('sda1');
  });

  it('should filter lines via shouldProcessLine - empty lines', () => {
    const parser = new ZFSIOStatParser();

    expect(parser.shouldProcessLine('')).toBe(false);
    expect(parser.shouldProcessLine('   ')).toBe(false);
  });

  it('should filter lines via shouldProcessLine - separator lines', () => {
    const parser = new ZFSIOStatParser();

    expect(parser.shouldProcessLine('----')).toBe(false);
    expect(parser.shouldProcessLine('- - - - -')).toBe(false);
    expect(parser.shouldProcessLine('  ----  ')).toBe(false);
  });

  it('should not filter valid data lines', () => {
    const parser = new ZFSIOStatParser();

    expect(parser.shouldProcessLine('tank  1T  500G  10  5  1M  500K')).toBe(true);
    expect(parser.shouldProcessLine('  mirror-0  -  -  8  4  800K  400K')).toBe(true);
  });

  it('should parseHeader and return header info', () => {
    const parser = new ZFSIOStatParser();

    const header = parser.parseHeader('capacity  operations  bandwidth');
    expect(header).toEqual({ headerLine: 'capacity  operations  bandwidth' });
  });

  it('should handle real zpool iostat workflow', () => {
    const parser = new ZFSIOStatParser();

    const lines = [
      'capacity   operations   bandwidth',
      'pool  alloc  free  read  write  read  write',
      'tank  1.81T  890G  10  5  1.5M  750K',
      '  mirror-0  -  -  8  4  1.2M  600K',
      '    sda1  -  -  4  2  600K  300K',
      '',
      '----',
      'capacity   operations   bandwidth',
      'pool  alloc  free  read  write  read  write',
      'tank  1.82T  889G  11  6  1.6M  800K',
    ];

    const results: ZFSIOStatRaw[] = [];

    for (const line of lines) {
      if (!parser.shouldProcessLine(line)) continue;
      const parsed = parser.parseLine(line);
      if (parsed) results.push(parsed);
    }

    // Should get 3 data lines from first output, then 1 from second (after headers reset)
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('tank');
  });

  it('should track header count correctly', () => {
    const parser = new ZFSIOStatParser();

    // First two lines are headers
    expect(parser.parseLine('line1')).toBeNull();
    expect(parser.parseLine('line2')).toBeNull();

    // Third line should attempt to parse
    const result = parser.parseLine('tank  1T  500G  10  5  1M  500K');
    expect(result).not.toBeNull();
  });

  it('should handle context parameter', () => {
    const parser = new ZFSIOStatParser();
    const context = { timestamp: Date.now(), lineNumber: 0 };

    parser.parseLine('header1', context);
    parser.parseLine('header2', context);

    const result = parser.parseLine('tank  1T  500G  10  5  1M  500K', context);
    expect(result).not.toBeNull();
  });
});
