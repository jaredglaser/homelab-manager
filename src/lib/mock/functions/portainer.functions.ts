/**
 * Mock Portainer server functions for demo mode.
 */

export const getPortainerStatus = async (): Promise<{ configured: boolean }> => {
  return { configured: true };
};

export const getPortainerStacks = async (): Promise<
  Array<{
    id: number;
    name: string;
    endpointId: number;
    endpointName: string;
    status: number;
  }>
> => {
  return [
    { id: 1, name: 'media', endpointId: 1, endpointName: 'local', status: 1 },
    { id: 2, name: 'monitoring', endpointId: 1, endpointName: 'local', status: 1 },
    { id: 3, name: 'infrastructure', endpointId: 1, endpointName: 'local', status: 1 },
  ];
};

export const getRedeployDryRun = async (
  _opts?: {
    data?: { stackId: number };
  },
): Promise<{
  stackName: string;
  endpointId: number;
  containers: Array<{
    name: string;
    image: string;
    currentTag: string | null;
    latestTag: string | null;
    updateAvailable: boolean;
  }>;
} | null> => {
  return {
    stackName: 'media',
    endpointId: 1,
    containers: [
      {
        name: 'plex',
        image: 'plexinc/pms-docker:latest',
        currentTag: 'latest',
        latestTag: '1.41.3.9314',
        updateAvailable: true,
      },
      {
        name: 'jellyfin',
        image: 'jellyfin/jellyfin:latest',
        currentTag: 'latest',
        latestTag: '10.10.6',
        updateAvailable: false,
      },
    ],
  };
};

export const redeployStack = async (
  _opts?: {
    data?: { stackId: number; endpointId: number };
  },
): Promise<{ success: boolean; error?: string }> => {
  return { success: true };
};
