/**
 * Format a number as a percentage with 2 decimal places
 * @param value - The percentage value (0-100)
 * @returns Formatted string (e.g., "45.67%")
 */
export function formatAsPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}


/**
 * Formats bytes with 2 decimal places ie Kilobyte = 1024 bytes
 * Converts to KiB/s for values >= 1024
 * Converts to MiB/s for values >= 1024 * 1024
 * Converts to GiB/s for values >= 1024 * 1024 * 1024
 * @param bytes - The B/s value
 * @returns Formatted string (e.g., "125.50 MB/s")
 */
export function formatBytes(bytes: number, isPerSecond: boolean): string {

  if (bytes >= 1024*1024*1024){
    return `${(bytes/(1024*1024*1024)).toFixed(2)} ${isPerSecond ? 'GiB/s':'GiB'}`;
  }
  else if (bytes >= 1024*1024){
    return `${(bytes/(1024*1024)).toFixed(2)} ${isPerSecond ? 'MiB/s':'MiB'}`;
  }
  else if(bytes >= 1024)
   return `${(bytes/(1024)).toFixed(2)} ${isPerSecond ? 'KiB/s':'KiB'}`;
  else {
    return `${bytes.toFixed(2)} ${isPerSecond ? 'B/s':'B'}`;
  }
  
}

/**
 * Formats bits with 2 decimal places using SI units, ie Kilobit = 1000 bits
  * Converts to Kbps for values >= 1000
 * Converts to Mbps for values >= 1000 * 1000
 * Converts to Gbps/s for values >= 1000 * 1000 * 1000
 * @param value - The bps value
 * @returns Formatted string (e.g., "125.50 Mbps" or "1.25 Gbps")
 */
export function formatBitsSIUnits(bits: number, isPerSecond: boolean): string {
  if (bits >= 1000*1000*1000) {
    return `${(bits / (1000 * 1000 * 1000)).toFixed(2)} ${isPerSecond ? 'Gbps':'Gb'}`;
  }
  else if(bits >= 1000 * 1000) {
    return `${(bits / 1000 / 1000).toFixed(2)} ${isPerSecond ? 'Mbps':'Mb'}`;
  }
  else if(bits >= 1000) {
    return `${(bits / 1000).toFixed(2)} ${isPerSecond ? 'Kbps':'Kb'}`;
  }
  return `${bits.toFixed(2)} ${isPerSecond ? 'bps':'bp'}`;
}
