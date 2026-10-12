// A container cannot replace itself: the relay hands the request to the agent-updater sidecar, which owns Docker.
const DIGEST_REF_PATTERN = /@sha256:[0-9a-f]{64}$/;

// Digest-only contract: a floating tag here would let the sidecar converge to an image newer than the manager itself runs.
export async function handleAgentUpdate(
  docker: unknown,
  updaterUrl: string,
  triggerToken: string | undefined,
  request: Request,
): Promise<Response> {
  if (!docker) {
    return Response.json({ error: 'Docker capability not enabled' }, { status: 503 });
  }

  if (!triggerToken) {
    return Response.json(
      { error: 'Update trigger token is not configured on the agent. Regenerate the compose stack to set it.' },
      { status: 503 },
    );
  }

  let body: { targetImage?: unknown; updaterTargetImage?: unknown };
  try {
    body = (await request.json()) as { targetImage?: unknown; updaterTargetImage?: unknown };
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
  // null means the manager could not pin the updater image, so the sidecar must skip its self-recreate.
  let updaterTargetImage: string | undefined;
  if (body?.updaterTargetImage !== undefined && body?.updaterTargetImage !== null) {
    if (typeof body.updaterTargetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.updaterTargetImage)) {
      return Response.json(
        { error: 'updaterTargetImage must be an image reference pinned to a sha256 digest' },
        { status: 400 },
      );
    }
    updaterTargetImage = body.updaterTargetImage;
  }

  let response: Response;
  try {
    response = await fetch(updaterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + triggerToken },
      body: JSON.stringify(updaterTargetImage ? { targetImage: body.targetImage, updaterTargetImage } : { targetImage: body.targetImage }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: 'agent-updater sidecar is not reachable. The agent stack has no agent-updater container, or it is not listening.' },
      { status: 503 },
    );
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return Response.json(
      { error: 'agent-updater trigger endpoint returned an unexpected redirect' },
      { status: 502 },
    );
  }

  const rawBody = await response.text().catch(() => '');
  let sidecarBody: { updateAvailable?: unknown; error?: unknown } = {};
  let sidecarTextError: string | undefined;
  try {
    sidecarBody = JSON.parse(rawBody) as { updateAvailable?: unknown; error?: unknown };
  } catch {
    // Plain-text bodies (auth and check-failure responses) carry the operator-facing message directly.
    if (rawBody) sidecarTextError = rawBody;
  }

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
    { error: sidecarBody.error ?? sidecarTextError ?? `agent-updater trigger endpoint returned ${response.status}` },
    { status: response.status === 200 ? 500 : response.status },
  );
}
