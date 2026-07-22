import type { z } from 'zod';

/**
 * Structural identity for one SSE channel, shared verbatim by the server route
 * (`src/routes/api/*.ts`, via the factories in `create-broadcast-sse-handler.ts`
 * and `create-stats-sse-handler.ts`) and the client (`useSseChannel`). Before
 * this module, `url` and `errorEvent` were a matched pair of string literals
 * hand-typed once per file on each side; a rename on one side and not the
 * other (#262) compiled fine and only failed at runtime.
 *
 * `schema` validates the parsed SSE payload (already JSON.parsed by
 * `useEventSource`, still wire-shaped: any Date field is an ISO string,
 * `JSON.stringify` has no Date type to preserve). `revive` runs once, right
 * after validation, turning that wire shape into whatever shape consumers
 * actually want to work with (Dates, epoch-ms numbers, etc).
 */
export interface SseChannelDescriptor<TSchema extends z.ZodTypeAny, TRevived = z.infer<TSchema>> {
  /** Route path this channel is served from, e.g. `/api/docker-inventory`. No base-path prefix; the client applies `apiUrl()`. */
  url: string;
  /** Named SSE event the server emits when the channel's data source fails. */
  errorEvent: string;
  /** Validates the parsed SSE message against its wire shape. */
  schema: TSchema;
  /** Transforms a validated wire message into the shape consumers use. */
  revive: (raw: z.infer<TSchema>) => TRevived;
}

/**
 * Identity function with a constrained signature: gives descriptor object
 * literals full inference (including the literal `url`/`errorEvent` strings
 * and the schema's inferred type) without callers having to spell out the
 * generic parameters by hand.
 */
export function defineSseChannel<TSchema extends z.ZodTypeAny, TRevived = z.infer<TSchema>>(
  descriptor: SseChannelDescriptor<TSchema, TRevived>,
): SseChannelDescriptor<TSchema, TRevived> {
  return descriptor;
}
