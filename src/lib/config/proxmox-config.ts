/** What a Proxmox client needs to reach one cluster. */
export interface ProxmoxConfig {
  host: string;
  port: number;
  tokenId: string;
  tokenSecret: string;
  allowSelfSignedCerts: boolean;
}

/** A connection saved in Settings, as the worker runs it. */
export interface ProxmoxConnection extends ProxmoxConfig {
  id: number;
  name: string;
}
