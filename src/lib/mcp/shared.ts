import { z } from 'zod';

export const MAX_RESULT_BYTES = 256_000;

const RELATIVE_TIME = /^(\d{1,6})([smhd])$/;
const DURATION_MULTIPLIER_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export const zTime = z.string().refine((v) => RELATIVE_TIME.test(v) || !Number.isNaN(Date.parse(v)), {
  message: "Expected an ISO 8601 timestamp (2026-08-15T12:00:00Z) or a relative duration ('30m', '4h', '7d')",
});

export const zEntityId = z.string().regex(/^[^/\s]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, {
  message:
    "Expected an entity id of the form '<host>/<containerId>', e.g. 'nuc1/9f2c1ab34de5'. Display names are not accepted; call list_containers to resolve one.",
});

export type McpErrorCode =
  | 'unknown_host'
  | 'unknown_container'
  | 'unknown_stack'
  | 'unknown_finding'
  | 'host_unreachable'
  | 'agent_error'
  | 'invalid_window'
  | 'window_too_large'
  | 'invalid_cursor'
  | 'invalid_pattern';

export class McpToolError extends Error {
  constructor(
    public code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export function ok<T extends object>(structured: T) {
  const json = JSON.stringify(structured);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(`Tool result of ${bytes} bytes exceeds the ${MAX_RESULT_BYTES} byte cap`);
  }
  return {
    content: [{ type: 'text' as const, text: json }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

export function fail(err: McpToolError) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
  };
}

/** `mcp:read` is the umbrella scope: any token carrying it can call every registered tool. */
export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes('mcp:read');
}

/** No umbrella fallback: used to gate write tools where `mcp:read` must not imply write access. */
export function hasExactScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

export function iso(value: Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function parseEntityId(entityId: string): { host: string; containerId: string } {
  const idx = entityId.indexOf('/');
  return { host: entityId.slice(0, idx), containerId: entityId.slice(idx + 1) };
}

export interface ResolvedWindow {
  from: Date;
  to: Date;
  spanSeconds: number;
}

function resolveTime(value: string, now: number): Date {
  const relative = RELATIVE_TIME.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as keyof typeof DURATION_MULTIPLIER_MS;
    return new Date(now - amount * DURATION_MULTIPLIER_MS[unit]);
  }
  return new Date(Date.parse(value));
}

export function resolveWindow(
  input: { since?: string; until?: string },
  opts: { defaultSinceSeconds: number; maxSpanSeconds: number },
): ResolvedWindow {
  const now = Date.now();
  const to = input.until !== undefined ? resolveTime(input.until, now) : new Date(now);
  const from = input.since !== undefined ? resolveTime(input.since, now) : new Date(now - opts.defaultSinceSeconds * 1000);

  if (from.getTime() >= to.getTime()) {
    throw new McpToolError('invalid_window', 'The requested window is empty or inverted: since must be before until');
  }

  const spanSeconds = (to.getTime() - from.getTime()) / 1000;
  if (spanSeconds > opts.maxSpanSeconds) {
    throw new McpToolError(
      'window_too_large',
      `The requested window spans ${Math.round(spanSeconds)}s, which exceeds the ${opts.maxSpanSeconds}s cap for this tool`,
    );
  }

  return { from, to, spanSeconds };
}

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T>(raw: string): T {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    throw new McpToolError('invalid_cursor', 'The cursor could not be decoded; it may be malformed or from a different tool call');
  }
}
