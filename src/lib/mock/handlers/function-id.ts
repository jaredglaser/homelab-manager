/**
 * TanStack Start compiles every `createServerFn()` call site into an RPC fetch to
 * `${TSS_SERVER_FN_BASE}/<functionId>`. The functionId format depends on the build:
 *
 * - Dev: base64url(JSON.stringify({ file, export })) (the compiler's default).
 * - Prod: whatever `serverFns.generateFunctionId` returns in vite.config.ts. We
 *   deliberately mirror the dev format there so a single decoder works in both
 *   builds, which keeps the MSW dispatch table keyed by the plain export name.
 *
 * This module owns that decode so handlers never reach into TanStack internals.
 */

interface DecodedFunctionId {
  file: string;
  export: string;
}

function base64UrlToString(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  // atob exists in the browser and in the Happy-DOM test environment.
  const binary = atob(withPadding);
  // The payload is UTF-8 JSON; decode byte-by-byte so multibyte names survive.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The compiler exposes the split handler under `<exportName>_createServerFn_handler`,
 * and that suffixed name is what lands in the function id. Strip it so dispatch
 * keys on the bare export name the app authored (e.g. `getSession`).
 */
function stripHandlerSuffix(name: string): string {
  return name.replace(/_createServerFn_handler$/, '');
}

/**
 * Resolve the server function's export name from the URL path segment.
 * Returns null when the segment is not a decodable TanStack function id.
 */
export function resolveFunctionName(functionIdSegment: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(functionIdSegment);
  } catch {
    // Malformed percent-encoding (e.g. "%", "%ZZ") would otherwise throw and
    // break dispatch; treat it as unresolvable.
    return null;
  }
  try {
    const decoded = JSON.parse(base64UrlToString(id)) as Partial<DecodedFunctionId>;
    if (decoded && typeof decoded.export === 'string') return stripHandlerSuffix(decoded.export);
  } catch {
    // Not base64url JSON: fall through and treat the raw segment as the name.
  }
  // Custom prod ids that are not base64url JSON fall back to the raw segment.
  return id.length > 0 ? stripHandlerSuffix(id) : null;
}

/**
 * Build the stable function id that vite.config.ts hands TanStack Start for
 * production builds. Kept here so the encoder and decoder live together.
 */
export function encodeFunctionId(file: string, exportName: string): string {
  const json = JSON.stringify({ file, export: exportName });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Extract the trailing `/_serverFn/<id>` segment from a full request URL. */
export function functionIdFromUrl(url: string): string | null {
  const match = /\/_serverFn\/([^/?#]+)/.exec(url);
  return match ? match[1] : null;
}
