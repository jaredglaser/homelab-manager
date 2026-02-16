import type { IPAssignment, SubnetInfo } from '@/types/proxmox';

/**
 * Parse an IPv4 address string to a 32-bit integer.
 */
export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return 0;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert a 32-bit integer to an IPv4 address string.
 */
export function intToIp(num: number): string {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join('.');
}

/**
 * Parse a CIDR notation string (e.g., "192.168.1.0/24") into network address and prefix.
 */
export function parseCIDR(cidr: string): { network: string; prefix: number } | null {
  const match = cidr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!match) return null;

  const ip = match[1];
  const prefix = parseInt(match[2], 10);

  if (prefix < 0 || prefix > 32) return null;

  const parts = ip.split('.').map(Number);
  if (parts.some(p => p < 0 || p > 255)) return null;

  // Calculate network address
  const ipInt = ipToInt(ip);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const networkInt = (ipInt & mask) >>> 0;

  return {
    network: intToIp(networkInt),
    prefix,
  };
}

/**
 * Calculate the total number of usable host addresses in a subnet.
 * /31 and /32 are special cases.
 */
export function totalHostsInSubnet(prefix: number): number {
  if (prefix >= 31) return prefix === 31 ? 2 : 1;
  return Math.pow(2, 32 - prefix) - 2; // Subtract network and broadcast
}

/**
 * Get the broadcast address for a subnet.
 */
export function broadcastAddress(network: string, prefix: number): string {
  const networkInt = ipToInt(network);
  const hostBits = 32 - prefix;
  const broadcastInt = (networkInt | ((1 << hostBits) - 1)) >>> 0;
  return intToIp(broadcastInt);
}

/**
 * Find the next available IP in a subnet that is not in use.
 * Returns null if the subnet is full.
 */
export function findNextAvailableIP(
  network: string,
  prefix: number,
  usedIPs: string[]
): string | null {
  const networkInt = ipToInt(network);
  const hostBits = 32 - prefix;
  const totalAddresses = 1 << hostBits;
  const usedSet = new Set(usedIPs.map(ip => ipToInt(ip)));

  // Skip network address (first) and broadcast address (last) for normal subnets
  const start = prefix >= 31 ? 0 : 1;
  const end = prefix >= 31 ? totalAddresses : totalAddresses - 1;

  for (let offset = start; offset < end; offset++) {
    const candidateInt = (networkInt + offset) >>> 0;
    if (!usedSet.has(candidateInt)) {
      return intToIp(candidateInt);
    }
  }

  return null;
}

/**
 * Parse IP addresses from Proxmox LXC network config strings.
 * Format: "name=eth0,bridge=vmbr0,ip=192.168.1.100/24,..."
 */
export function parseIPFromNetConfig(netConfig: string): string | null {
  const ipMatch = netConfig.match(/ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/\d{1,2})?/);
  if (ipMatch) return ipMatch[1];
  return null;
}

/**
 * Parse CIDR from Proxmox LXC network config strings.
 * Returns the full CIDR (e.g., "192.168.1.100/24").
 */
export function parseCIDRFromNetConfig(netConfig: string): string | null {
  const ipMatch = netConfig.match(/ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})/);
  if (ipMatch) return ipMatch[1];
  return null;
}

/**
 * Analyze IP assignments and group them by subnet.
 * Returns subnet information with used IPs and next available.
 */
export function analyzeSubnets(assignments: IPAssignment[]): SubnetInfo[] {
  // Group IPs by their subnet
  const subnetMap = new Map<string, { network: string; prefix: number; ips: IPAssignment[] }>();

  for (const assignment of assignments) {
    // Try to find which subnet this IP belongs to
    // We need the CIDR from the config, not just the IP
    // For now, group by /24 if no CIDR info is available
    const ipInt = ipToInt(assignment.ip);
    if (ipInt === 0) continue;

    // Default to /24 subnet
    const mask24 = (~0 << 8) >>> 0;
    const networkInt = (ipInt & mask24) >>> 0;
    const networkAddr = intToIp(networkInt);
    const cidr = `${networkAddr}/24`;

    let subnet = subnetMap.get(cidr);
    if (!subnet) {
      subnet = { network: networkAddr, prefix: 24, ips: [] };
      subnetMap.set(cidr, subnet);
    }
    subnet.ips.push(assignment);
  }

  return Array.from(subnetMap.entries()).map(([cidr, subnet]) => ({
    cidr,
    network: subnet.network,
    prefix: subnet.prefix,
    usedIPs: subnet.ips.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)),
    totalHosts: totalHostsInSubnet(subnet.prefix),
    usedCount: subnet.ips.length,
    nextAvailable: findNextAvailableIP(
      subnet.network,
      subnet.prefix,
      subnet.ips.map(a => a.ip)
    ),
  }));
}

/**
 * Analyze subnets with known CIDR information.
 * Takes a map of CIDR strings to their IP assignments.
 */
export function analyzeSubnetsWithCIDR(
  cidrAssignments: Map<string, IPAssignment[]>
): SubnetInfo[] {
  const results: SubnetInfo[] = [];

  for (const [cidrStr, assignments] of cidrAssignments) {
    const parsed = parseCIDR(cidrStr);
    if (!parsed) continue;

    results.push({
      cidr: `${parsed.network}/${parsed.prefix}`,
      network: parsed.network,
      prefix: parsed.prefix,
      usedIPs: assignments.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)),
      totalHosts: totalHostsInSubnet(parsed.prefix),
      usedCount: assignments.length,
      nextAvailable: findNextAvailableIP(
        parsed.network,
        parsed.prefix,
        assignments.map(a => a.ip)
      ),
    });
  }

  return results.sort((a, b) => ipToInt(a.network) - ipToInt(b.network));
}
