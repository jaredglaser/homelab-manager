import { describe, it, expect } from 'bun:test';
import {
  ipToInt,
  intToIp,
  parseCIDR,
  totalHostsInSubnet,
  broadcastAddress,
  findNextAvailableIP,
  parseIPFromNetConfig,
  parseCIDRFromNetConfig,
  analyzeSubnets,
  analyzeSubnetsWithCIDR,
} from '../ip-utils';
import type { IPAssignment } from '@/types/proxmox';

describe('ipToInt', () => {
  it('should convert 0.0.0.0 to 0', () => {
    expect(ipToInt('0.0.0.0')).toBe(0);
  });

  it('should convert 255.255.255.255 to max uint32', () => {
    expect(ipToInt('255.255.255.255')).toBe(4294967295);
  });

  it('should convert 192.168.1.1 correctly', () => {
    expect(ipToInt('192.168.1.1')).toBe(3232235777);
  });

  it('should convert 10.0.0.1 correctly', () => {
    expect(ipToInt('10.0.0.1')).toBe(167772161);
  });

  it('should return 0 for invalid IP', () => {
    expect(ipToInt('invalid')).toBe(0);
    expect(ipToInt('256.1.1.1')).toBe(0);
    expect(ipToInt('1.2.3')).toBe(0);
  });
});

describe('intToIp', () => {
  it('should convert 0 to 0.0.0.0', () => {
    expect(intToIp(0)).toBe('0.0.0.0');
  });

  it('should convert max uint32 to 255.255.255.255', () => {
    expect(intToIp(4294967295)).toBe('255.255.255.255');
  });

  it('should round-trip with ipToInt', () => {
    const testIPs = ['192.168.1.1', '10.0.0.1', '172.16.0.100', '1.2.3.4'];
    for (const ip of testIPs) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });
});

describe('parseCIDR', () => {
  it('should parse 192.168.1.0/24', () => {
    const result = parseCIDR('192.168.1.0/24');
    expect(result).not.toBeNull();
    expect(result!.network).toBe('192.168.1.0');
    expect(result!.prefix).toBe(24);
  });

  it('should calculate network address from host IP', () => {
    const result = parseCIDR('192.168.1.100/24');
    expect(result).not.toBeNull();
    expect(result!.network).toBe('192.168.1.0');
    expect(result!.prefix).toBe(24);
  });

  it('should handle /16 subnets', () => {
    const result = parseCIDR('10.0.5.100/16');
    expect(result).not.toBeNull();
    expect(result!.network).toBe('10.0.0.0');
    expect(result!.prefix).toBe(16);
  });

  it('should handle /32 host route', () => {
    const result = parseCIDR('10.0.0.1/32');
    expect(result).not.toBeNull();
    expect(result!.network).toBe('10.0.0.1');
    expect(result!.prefix).toBe(32);
  });

  it('should return null for invalid CIDR', () => {
    expect(parseCIDR('invalid')).toBeNull();
    expect(parseCIDR('192.168.1.0')).toBeNull();
    expect(parseCIDR('192.168.1.0/33')).toBeNull();
    expect(parseCIDR('')).toBeNull();
  });
});

describe('totalHostsInSubnet', () => {
  it('should return 254 for /24', () => {
    expect(totalHostsInSubnet(24)).toBe(254);
  });

  it('should return 65534 for /16', () => {
    expect(totalHostsInSubnet(16)).toBe(65534);
  });

  it('should return 2 for /31', () => {
    expect(totalHostsInSubnet(31)).toBe(2);
  });

  it('should return 1 for /32', () => {
    expect(totalHostsInSubnet(32)).toBe(1);
  });

  it('should return 14 for /28', () => {
    expect(totalHostsInSubnet(28)).toBe(14);
  });
});

describe('broadcastAddress', () => {
  it('should return 192.168.1.255 for 192.168.1.0/24', () => {
    expect(broadcastAddress('192.168.1.0', 24)).toBe('192.168.1.255');
  });

  it('should return 10.0.255.255 for 10.0.0.0/16', () => {
    expect(broadcastAddress('10.0.0.0', 16)).toBe('10.0.255.255');
  });

  it('should return 192.168.1.15 for 192.168.1.0/28', () => {
    expect(broadcastAddress('192.168.1.0', 28)).toBe('192.168.1.15');
  });
});

describe('findNextAvailableIP', () => {
  it('should find next available IP in empty /24', () => {
    const result = findNextAvailableIP('192.168.1.0', 24, []);
    expect(result).toBe('192.168.1.1');
  });

  it('should skip used IPs', () => {
    const used = ['192.168.1.1', '192.168.1.2', '192.168.1.3'];
    const result = findNextAvailableIP('192.168.1.0', 24, used);
    expect(result).toBe('192.168.1.4');
  });

  it('should find gaps between used IPs', () => {
    const used = ['192.168.1.1', '192.168.1.3'];
    const result = findNextAvailableIP('192.168.1.0', 24, used);
    expect(result).toBe('192.168.1.2');
  });

  it('should return null when subnet is full', () => {
    // /30 has only 2 usable IPs: .1 and .2
    const used = ['192.168.1.1', '192.168.1.2'];
    const result = findNextAvailableIP('192.168.1.0', 30, used);
    expect(result).toBeNull();
  });

  it('should skip network and broadcast addresses', () => {
    const used: string[] = [];
    const result = findNextAvailableIP('192.168.1.0', 24, used);
    // Should NOT return .0 (network) or .255 (broadcast)
    expect(result).toBe('192.168.1.1');
  });
});

describe('parseIPFromNetConfig', () => {
  it('should parse IP from LXC net config', () => {
    const config = 'name=eth0,bridge=vmbr0,firewall=1,hwaddr=AA:BB:CC:DD:EE:FF,ip=192.168.1.100/24,type=veth';
    expect(parseIPFromNetConfig(config)).toBe('192.168.1.100');
  });

  it('should parse IP without CIDR suffix', () => {
    const config = 'name=eth0,ip=10.0.0.5';
    expect(parseIPFromNetConfig(config)).toBe('10.0.0.5');
  });

  it('should return null for DHCP config', () => {
    const config = 'name=eth0,bridge=vmbr0,ip=dhcp';
    expect(parseIPFromNetConfig(config)).toBeNull();
  });

  it('should return null for empty config', () => {
    expect(parseIPFromNetConfig('')).toBeNull();
  });
});

describe('parseCIDRFromNetConfig', () => {
  it('should parse CIDR from LXC net config', () => {
    const config = 'name=eth0,bridge=vmbr0,ip=192.168.1.100/24,type=veth';
    expect(parseCIDRFromNetConfig(config)).toBe('192.168.1.100/24');
  });

  it('should return null for IP without CIDR', () => {
    const config = 'name=eth0,ip=10.0.0.5';
    expect(parseCIDRFromNetConfig(config)).toBeNull();
  });
});

describe('analyzeSubnets', () => {
  it('should group IPs by /24 subnet', () => {
    const assignments: IPAssignment[] = [
      { ip: '192.168.1.10', entity: 'pve1/lxc/100', name: 'ct1', type: 'lxc', vmid: 100, node: 'pve1' },
      { ip: '192.168.1.20', entity: 'pve1/lxc/101', name: 'ct2', type: 'lxc', vmid: 101, node: 'pve1' },
      { ip: '192.168.2.10', entity: 'pve1/qemu/200', name: 'vm1', type: 'qemu', vmid: 200, node: 'pve1' },
    ];

    const subnets = analyzeSubnets(assignments);

    expect(subnets).toHaveLength(2);

    const subnet1 = subnets.find(s => s.cidr === '192.168.1.0/24');
    expect(subnet1).toBeDefined();
    expect(subnet1!.usedCount).toBe(2);
    expect(subnet1!.totalHosts).toBe(254);

    const subnet2 = subnets.find(s => s.cidr === '192.168.2.0/24');
    expect(subnet2).toBeDefined();
    expect(subnet2!.usedCount).toBe(1);
  });

  it('should find next available IP', () => {
    const assignments: IPAssignment[] = [
      { ip: '192.168.1.1', entity: 'pve1/lxc/100', name: 'ct1', type: 'lxc', vmid: 100, node: 'pve1' },
      { ip: '192.168.1.2', entity: 'pve1/lxc/101', name: 'ct2', type: 'lxc', vmid: 101, node: 'pve1' },
    ];

    const subnets = analyzeSubnets(assignments);
    expect(subnets[0].nextAvailable).toBe('192.168.1.3');
  });

  it('should sort IPs within subnet', () => {
    const assignments: IPAssignment[] = [
      { ip: '192.168.1.20', entity: 'pve1/lxc/101', name: 'ct2', type: 'lxc', vmid: 101, node: 'pve1' },
      { ip: '192.168.1.10', entity: 'pve1/lxc/100', name: 'ct1', type: 'lxc', vmid: 100, node: 'pve1' },
    ];

    const subnets = analyzeSubnets(assignments);
    expect(subnets[0].usedIPs[0].ip).toBe('192.168.1.10');
    expect(subnets[0].usedIPs[1].ip).toBe('192.168.1.20');
  });

  it('should handle empty assignments', () => {
    const subnets = analyzeSubnets([]);
    expect(subnets).toHaveLength(0);
  });
});

describe('analyzeSubnetsWithCIDR', () => {
  it('should analyze subnets with known CIDR', () => {
    const assignments = new Map<string, IPAssignment[]>();
    assignments.set('192.168.1.0/24', [
      { ip: '192.168.1.10', entity: 'pve1/lxc/100', name: 'ct1', type: 'lxc', vmid: 100, node: 'pve1' },
    ]);

    const subnets = analyzeSubnetsWithCIDR(assignments);
    expect(subnets).toHaveLength(1);
    expect(subnets[0].cidr).toBe('192.168.1.0/24');
    expect(subnets[0].usedCount).toBe(1);
    expect(subnets[0].nextAvailable).toBe('192.168.1.1');
  });

  it('should sort subnets by network address', () => {
    const assignments = new Map<string, IPAssignment[]>();
    assignments.set('10.0.0.0/24', []);
    assignments.set('192.168.1.0/24', []);

    const subnets = analyzeSubnetsWithCIDR(assignments);
    expect(subnets[0].network).toBe('10.0.0.0');
    expect(subnets[1].network).toBe('192.168.1.0');
  });
});
