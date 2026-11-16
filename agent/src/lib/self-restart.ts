import type Dockerode from 'dockerode';

/**
 * Give the enroll response time to reach the manager before the restart kills
 * this process. The manager reads the enroll response (and the
 * selfRestartScheduled flag inside it) before it starts polling HTTPS, so any
 * delay works. 2s keeps a manual `docker logs` follow readable.
 */
export const SELF_RESTART_DELAY_MS = 2000;

/**
 * Schedule a restart of the agent's own container. Returns whether a restart
 * was scheduled (false when Docker is unavailable), so the caller can report
 * it to the manager. A first-boot agent in restricted plain-HTTP mode cannot
 * be restarted by the manager - the restricted gate blocks the restart
 * endpoint by design - so restarting itself is the only way provisioning can
 * complete. Called only from that mode, never during a TLS rotation where the
 * manager drives the restart over the existing HTTPS channel.
 */
export function scheduleSelfRestart(
  docker: Dockerode | null,
  containerName: string,
  delayMs: number = SELF_RESTART_DELAY_MS,
): boolean {
  if (!docker) return false;
  setTimeout(() => {
    docker
      .getContainer(containerName)
      .restart()
      .catch((err: unknown) => {
        // The restart call can still fail after the response left (socket
        // proxy down, container missing). Nothing can retry it from inside a
        // dying process. Log so `docker logs` shows why provisioning stalled.
        console.error(`Self-restart of container '${containerName}' after TLS enrollment failed:`, err);
      });
  }, delayMs);
  return true;
}
