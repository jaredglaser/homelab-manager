import { createServerFn } from '@tanstack/react-start';

/**
 * Test the Proxmox API connection.
 */
export const testProxmoxConnection = createServerFn()
  .handler(async (): Promise<{ connected: boolean; error?: string }> => {
    try {
      const { isProxmoxConfigured, loadProxmoxConfig } = await import(
        '@/lib/config/proxmox-config'
      );

      if (!isProxmoxConfigured()) {
        return { connected: false, error: 'Proxmox is not configured. Set PROXMOX_HOST, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET environment variables.' };
      }

      const { proxmoxConnectionManager } = await import(
        '@/lib/clients/proxmox-client'
      );

      const config = loadProxmoxConfig();
      const client = proxmoxConnectionManager.getClient(config);
      const connected = await client.testConnection();

      return connected
        ? { connected: true }
        : { connected: false, error: 'Failed to connect to Proxmox API' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[testProxmoxConnection] Failed:', message);
      return { connected: false, error: message };
    }
  });
