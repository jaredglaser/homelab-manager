import { z } from 'zod';
import { TLS_FAILURE_CODES } from '@homelab-manager/agent/types';
import { TLS_PROVISIONING_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';
import type { TlsProvisioningSnapshot } from '@/lib/hosts/tls-provisioning-jobs';

const zTlsProvisioningOutcomeWire = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), agentUrl: z.string(), enrolledOverPlainHttp: z.boolean(), fingerprint: z.string() }),
  z.object({ ok: z.literal(false), code: z.enum(TLS_FAILURE_CODES).nullable(), message: z.string() }),
]);

const zTlsProvisioningJobWire = z.object({
  jobId: z.string(),
  hostId: z.number(),
  state: z.enum(['running', 'finished']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: zTlsProvisioningOutcomeWire.nullable(),
});

export const zTlsProvisioningSnapshotWire = z.object({
  jobs: z.array(zTlsProvisioningJobWire),
}) satisfies z.ZodType<TlsProvisioningSnapshot>;

export const tlsProvisioningChannel: MuxChannel<typeof zTlsProvisioningSnapshotWire> = {
  topic: TLS_PROVISIONING_TOPIC,
  schema: zTlsProvisioningSnapshotWire,
};

export type { TlsProvisioningJob, TlsProvisioningSnapshot } from '@/lib/hosts/tls-provisioning-jobs';
