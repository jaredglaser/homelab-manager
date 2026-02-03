import type { StreamParser, ParseContext } from '../streaming/types';
import type { ZFSIOStatRaw } from '../../types/zfs';

/**
 * Parse ZFS size values with units (K, M, G, T, P)
 * Examples: "1.81T", "890K", "40.2M"
 *
 * @param value - Value string with optional unit suffix
 * @returns Size in bytes
 */
function parseIOStatValue(value: string): number {
  if (!value || value === '-') return 0;

  const match = value.match(/^([\d.]+)([KMGTP]?)$/i);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  const multipliers: Record<string, number> = {
    '': 1,
    'K': 1024,
    'M': 1024 * 1024,
    'G': 1024 * 1024 * 1024,
    'T': 1024 * 1024 * 1024 * 1024,
    'P': 1024 * 1024 * 1024 * 1024 * 1024,
  };

  return num * (multipliers[unit] || 1);
}

/**
 * Parses a single line of zpool iostat output
 * Handles both pool-level and vdev-level statistics
 *
 * @param line - Line of zpool iostat output
 * @param context - Optional parsing context
 * @returns Parsed ZFS iostat data or null if not a data line
 */
export function parseZFSIOStat(
  line: string,
  context?: ParseContext
): ZFSIOStatRaw | null {
  // Skip separator lines (dashes and whitespace only)
  if (line.match(/^[-\s]+$/)) {
    return null;
  }

  // Skip header lines (e.g. "capacity  operations  bandwidth" or "pool  alloc  free  read  write")
  if (
    (line.includes('capacity') && line.includes('operations') && line.includes('bandwidth')) ||
    (/\bpool\b/.test(line) && /\balloc\b/.test(line) && /\bfree\b/.test(line))
  ) {
    return null;
  }

  // Detect indentation level (count leading spaces before first non-space character)
  const indent = line.search(/\S/);
  if (indent < 0) return null; // empty line

  // Split by whitespace
  const parts = line.trim().split(/\s+/);

  // Must have at least 7 columns: name alloc free read write read write
  if (parts.length < 7) {
    return null;
  }

  const name = parts[0];
  const allocStr = parts[1];
  const freeStr = parts[2];
  // Use parseIOStatValue for operations too — zpool formats large values with K/M/G suffixes
  const readOps = parseIOStatValue(parts[3]);
  const writeOps = parseIOStatValue(parts[4]);
  const readBandwidth = parseIOStatValue(parts[5]);
  const writeBandwidth = parseIOStatValue(parts[6]);

  // Parse capacity (handle '-' for vdevs/disks that don't report capacity)
  const alloc = allocStr === '-' ? 0 : parseIOStatValue(allocStr);
  const free = freeStr === '-' ? 0 : parseIOStatValue(freeStr);

  // Reject lines where any numeric field parsed to NaN (e.g. header lines that slipped through)
  if ([readOps, writeOps, readBandwidth, writeBandwidth, alloc, free].some(v => Number.isNaN(v))) {
    return null;
  }

  return {
    name,
    indent,
    capacity: {
      alloc,
      free,
    },
    operations: {
      read: readOps,
      write: writeOps,
    },
    bandwidth: {
      read: readBandwidth,
      write: writeBandwidth,
    },
    total: {
      readOps: 0,
      writeOps: 0,
      readBytes: 0,
      writeBytes: 0,
    },
  };
}

/**
 * ZFS iostat parser class implementing StreamParser interface
 */
export class ZFSIOStatParser implements StreamParser<ZFSIOStatRaw> {
  private inDataSection = false;
  private headersSeen = 0;

  parseLine(line: string, context?: ParseContext): ZFSIOStatRaw | null {
    // Track headers (first 2 lines are headers)
    if (this.headersSeen < 2) {
      this.headersSeen++;
      return null;
    }

    this.inDataSection = true;
    return parseZFSIOStat(line, context);
  }

  shouldProcessLine(line: string): boolean {
    // Skip empty lines and separator lines
    return line.trim().length > 0 && !line.match(/^[-\s]+$/);
  }

  parseHeader(line: string): Record<string, unknown> {
    // Could extract column headers if needed for dynamic parsing
    return { headerLine: line };
  }
}
