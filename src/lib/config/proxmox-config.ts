export interface ProxmoxConfig {
  host: string;
  port: number;
  tokenId: string;
  tokenSecret: string;
  allowSelfSignedCerts: boolean;
}

export interface ProxmoxConnection extends ProxmoxConfig {
  id: number;
  name: string;
}
