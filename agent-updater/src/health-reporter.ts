/** Reports update status to the agent via its health endpoint. */
export class HealthReporter {
  private agentUrl: string;

  constructor(agentUrl: string) {
    this.agentUrl = agentUrl;
  }

  /** Check whether the agent is healthy by hitting its /health endpoint. */
  async checkAgentHealth(timeoutMs = 5000): Promise<boolean> {
    try {
      const response = await fetch(`${this.agentUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        return false;
      }

      return response.ok;
    } catch {
      return false;
    }
  }
}
