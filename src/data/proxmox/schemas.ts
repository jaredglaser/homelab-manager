import { z } from 'zod';

export const getHistoricalProxmoxStatsSchema = z.object({
  seconds: z.number().int().positive().optional().default(120),
});

const ADDRESS_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]+\]$/;
// The token travels in an HTTP header, which takes no spaces and no characters outside ASCII.
const TOKEN_PATTERN = /^[\x21-\x7E]+$/;

export function isValidProxmoxAddress(address: string): boolean {
  return address.length <= 253 && ADDRESS_PATTERN.test(address);
}

export function isValidProxmoxToken(token: string): boolean {
  return token.length <= 256 && TOKEN_PATTERN.test(token);
}

const connectionFields = {
  address: z.string().trim().refine(isValidProxmoxAddress),
  port: z.number().int().min(1).max(65535),
  tokenId: z.string().refine(isValidProxmoxToken),
  /** Empty keeps the stored secret of connection `id`. */
  tokenSecret: z.string().refine((secret) => secret === '' || isValidProxmoxToken(secret)),
  allowSelfSignedCerts: z.boolean(),
};

const secretGivenOrStored = {
  error: 'A new connection needs a token secret',
  path: ['tokenSecret'],
};

export const saveProxmoxConnectionSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().max(100).optional(),
  ...connectionFields,
}).refine((data) => data.id !== undefined || data.tokenSecret !== '', secretGivenOrStored);

export const testProxmoxConnectionSchema = z.object({
  id: z.number().int().positive().optional(),
  ...connectionFields,
}).refine((data) => data.id !== undefined || data.tokenSecret !== '', secretGivenOrStored);

export const removeProxmoxConnectionSchema = z.object({ id: z.number().int().positive() });

export type SaveProxmoxConnectionInput = z.infer<typeof saveProxmoxConnectionSchema>;
export type TestProxmoxConnectionInput = z.infer<typeof testProxmoxConnectionSchema>;
