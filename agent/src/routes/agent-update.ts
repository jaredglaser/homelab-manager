/**
 * Relay a manual update request to the host's agent-updater sidecar.
 *
 * A container cannot replace itself (stopping its own container kills the
 * process mid-update), so the actual update is performed by the agent-updater
 * container, which has Docker access and watches this agent. The relay is
 * authenticated by the standard agent JWT middleware; the sidecar endpoint is
 * internal-only (reachable from the compose Docker network, not published).
 *
 * The agent-updater answers either 200 { updateAvailable: false } when the
 * agent image is already current, or 202 { started: true } after kicking off
 * the update asynchronously. The caller (manager) polls the agent's health
 * and version endpoints to observe the result.
 *
 * @param docker - Dockerode client, or null if Docker capability is not enabled
 * @param updaterUrl - Base URL of the agent-updater trigger endpoint
 * @returns 503 when Docker is disabled or the sidecar is unreachable,
 *          200 when no update is available, 202 when the update was started
 */
export async function handleAgentUpdate(
  docker: unknown,
  updaterUrl: string,
): Promise<Response> {
  if (!docker) {
    return Response.json({ error: 'Docker capability not enabled' }, { status: 503 });
  }

  let response: Response;
  try {
    response = await fetch(updaterUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: 'agent-updater sidecar is not reachable; the agent stack has no agent-updater container or it is not listening' },
      { status: 503 },
    );
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return Response.json(
      { error: 'agent-updater trigger endpoint returned an unexpected redirect' },
      { status: 502 },
    );
  }

  const body = await response.json().catch(() => ({}));

  if (response.status === 202) {
    return Response.json({ started: true }, { status: 202 });
  }
  if (response.status === 200 && body.updateAvailable === false) {
    return Response.json({ updateAvailable: false });
  }
  if (response.status === 409) {
    return Response.json({ error: 'An update is already in progress' }, { status: 409 });
  }
  return Response.json(
    { error: body.error ?? `agent-updater trigger endpoint returned ${response.status}` },
    { status: response.status === 200 ? 500 : response.status },
  );
}
