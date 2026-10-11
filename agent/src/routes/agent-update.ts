// A container cannot replace itself: the relay hands the request to the agent-updater sidecar, which owns Docker.
const DIGEST_REF_PATTERN = /@sha256:[0-9a-f]{64}$/;

// Digest-only contract: a floating tag here would let the sidecar converge to an image newer than the manager itself runs.
export async function handleAgentUpdate(
  docker: unknown,
  updaterUrl: string,
  request: Request,
): Promise<Response> {
  if (!docker) {
    return Response.json({ error: 'Docker capability not enabled' }, { status: 503 });
  }

  let body: { targetImage?: unknown };
  try {
    body = (await request.json()) as { targetImage?: unknown };
  } catch {
    return Response.json(
      { error: 'Agent update requires a JSON body with a digest-pinned targetImage' },
      { status: 400 },
    );
  }
  if (typeof body?.targetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.targetImage)) {
    return Response.json(
      { error: 'targetImage must be an image reference pinned to a sha256 digest' },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(updaterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetImage: body.targetImage }),
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

  const sidecarBody = await response.json().catch(() => ({}));

  if (response.status === 202) {
    return Response.json({ started: true }, { status: 202 });
  }
  if (response.status === 200 && sidecarBody.updateAvailable === false) {
    return Response.json({ updateAvailable: false });
  }
  if (response.status === 409) {
    return Response.json({ error: 'An update is already in progress' }, { status: 409 });
  }
  return Response.json(
    { error: sidecarBody.error ?? `agent-updater trigger endpoint returned ${response.status}` },
    { status: response.status === 200 ? 500 : response.status },
  );
}
