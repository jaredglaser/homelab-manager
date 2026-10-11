// A container cannot replace itself: the relay hands the request to the agent-updater sidecar, which owns Docker.
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
