export interface AgentVersionCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export function checkAgentVersion(currentVersion: string, latestVersion: string): AgentVersionCheck {
  return {
    currentVersion,
    latestVersion,
    updateAvailable: currentVersion !== latestVersion,
  };
}
