/**
 * Mock update server functions for demo mode.
 */

export const getContainerUpdateDryRun = async (
  opts?: {
    data?: { containerId: string; host: string };
  },
): Promise<{
  containerId: string;
  containerName: string;
  image: string;
  currentTag: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  ports: number;
  volumes: number;
  networks: number;
  envVars: number;
} | null> => {
  return {
    containerId: opts?.data?.containerId ?? 'abc123',
    containerName: 'nginx',
    image: 'nginx:latest',
    currentTag: 'latest',
    latestTag: '1.27.3',
    updateAvailable: true,
    ports: 2,
    volumes: 3,
    networks: 1,
    envVars: 5,
  };
};

export const updateContainer = async (
  _opts?: {
    data?: { containerId: string; host: string };
  },
): Promise<{ success: boolean; error?: string }> => {
  return { success: true };
};
