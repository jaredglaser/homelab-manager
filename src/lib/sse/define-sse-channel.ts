import type { z } from 'zod';

/**
 * Structural identity for one SSE channel, shared by the server route and the client
 * (`useSseChannel`), so `url`/`errorEvent` can't drift between them like #262.
 * `schema` validates the parsed (still wire-shaped, e.g. dates as ISO strings) SSE
 * payload; `revive` turns it into the shape consumers want (Dates, epoch-ms, etc).
 */
export interface SseChannelDescriptor<TSchema extends z.ZodTypeAny, TRevived = z.infer<TSchema>> {
  /** Route path, e.g. `/api/docker-inventory`. No base-path prefix; the client applies `apiUrl()`. */
  url: string;
  /** Named SSE event the server emits when the channel's data source fails. */
  errorEvent: string;
  /** Validates the parsed SSE message against its wire shape. */
  schema: TSchema;
  /** Transforms a validated wire message into the shape consumers use. */
  revive: (raw: z.infer<TSchema>) => TRevived;
}

/** Identity function that lets a descriptor literal infer its literal `url`/`errorEvent` and schema type without spelling out the generics. */
export function defineSseChannel<TSchema extends z.ZodTypeAny, TRevived = z.infer<TSchema>>(
  descriptor: SseChannelDescriptor<TSchema, TRevived>,
): SseChannelDescriptor<TSchema, TRevived> {
  return descriptor;
}
