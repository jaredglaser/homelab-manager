/**
 * Format a number as a percentage
 * @param value - The percentage value (0-1)
 * @param showDecimals - Whether to show decimal places (default: true)
 * @returns Formatted string (e.g., "45.67%" or "46%")
 */
export function formatAsPercent(value: number, showDecimals = true): string {
  const decimals = showDecimals ? 2 : 0;
  return `${(value * 100).toFixed(decimals)}%`;
}


/**
 * Formats bytes ie Kilobyte = 1024 bytes
 * Converts to KiB/s for values >= 1024
 * Converts to MiB/s for values >= 1024 * 1024
 * Converts to GiB/s for values >= 1024 * 1024 * 1024
 * @param bytes - The B/s value
 * @param isPerSecond - Whether to show /s suffix
 * @param showDecimals - Whether to show decimal places (default: true)
 * @returns Formatted string (e.g., "125.50 MB/s" or "126 MB/s")
 */
export function formatBytes(bytes: number, isPerSecond: boolean, showDecimals = true): string {
  const decimals = showDecimals ? 2 : 0;

  if (bytes >= 1024*1024*1024*1024){
    return `${(bytes/(1024*1024*1024*1024)).toFixed(decimals)} ${isPerSecond ? 'TiB/s':'TiB'}`;
  }
  else if (bytes >= 1024*1024*1024){
    return `${(bytes/(1024*1024*1024)).toFixed(decimals)} ${isPerSecond ? 'GiB/s':'GiB'}`;
  }
  else if (bytes >= 1024*1024){
    return `${(bytes/(1024*1024)).toFixed(decimals)} ${isPerSecond ? 'MiB/s':'MiB'}`;
  }
  else if(bytes >= 1024)
   return `${(bytes/(1024)).toFixed(decimals)} ${isPerSecond ? 'KiB/s':'KiB'}`;
  else {
    return `${bytes.toFixed(decimals)} ${isPerSecond ? 'B/s':'B'}`;
  }
}

/**
 * Formats bits using SI units, ie Kilobit = 1000 bits
 * Converts to Kbps for values >= 1000
 * Converts to Mbps for values >= 1000 * 1000
 * Converts to Gbps for values >= 1000 * 1000 * 1000
 * @param bits - The bps value
 * @param isPerSecond - Whether to show /s suffix
 * @param showDecimals - Whether to show decimal places (default: true)
 * @returns Formatted string (e.g., "125.50 Mbps" or "126 Mbps")
 */
export function formatBitsSIUnits(bits: number, isPerSecond: boolean, showDecimals = true): string {
  const decimals = showDecimals ? 2 : 0;

  if (bits >= 1000*1000*1000) {
    return `${(bits / (1000 * 1000 * 1000)).toFixed(decimals)} ${isPerSecond ? 'Gbps':'Gb'}`;
  }
  else if(bits >= 1000 * 1000) {
    return `${(bits / 1000 / 1000).toFixed(decimals)} ${isPerSecond ? 'Mbps':'Mb'}`;
  }
  else if(bits >= 1000) {
    return `${(bits / 1000).toFixed(decimals)} ${isPerSecond ? 'Kbps':'Kb'}`;
  }
  return `${bits.toFixed(decimals)} ${isPerSecond ? 'bps':'bp'}`;
}
