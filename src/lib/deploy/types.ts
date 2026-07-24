import { z } from 'zod';

export const DEPLOY_ACTION_VALUES = ['deploy', 'teardown'] as const;
export type DeployAction = (typeof DEPLOY_ACTION_VALUES)[number];

export const DEPLOY_STATUS_VALUES = [
  'pending',
  'in_progress',
  'succeeded',
  'failed',
  'no_change',
] as const;
export type DeployStatus = (typeof DEPLOY_STATUS_VALUES)[number];

export const DEPLOY_TRIGGER_VALUES = ['git_push', 'ui', 'manual_rollback'] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGER_VALUES)[number];

/**
 * Wire shape for a deploy lifecycle outcome, broadcast over the `deploy_change`
 * NOTIFY channel and forwarded on the stack-status SSE stream. Single source of
 * truth for both the server-side broadcast parse and the client-side channel
 * schema, so the two can't drift.
 */
export const zDeployChangeOutcome = z.object({
  deployId: z.number().int().positive(),
  status: z.enum(DEPLOY_STATUS_VALUES),
  action: z.enum(DEPLOY_ACTION_VALUES),
  trigger: z.enum(DEPLOY_TRIGGER_VALUES),
  message: z.string().optional(),
});

export type DeployChangeOutcome = z.infer<typeof zDeployChangeOutcome>;

/**
 * Action to run inside the pipeline after a deploy reaches a terminal-success
 * state (`succeeded` or `no_change`). Currently only `removeFromManifest` is
 * supported, used by async teardown to delete the stack entry from the git
 * manifest once the agent reports teardown complete.
 */
export type DeployPostSuccess = 'removeFromManifest';

interface BaseDeployRequest {
  stack: string;
  host: string;
  commitSha: string;
  trigger: DeployTrigger;
  autoApproved: boolean;
  /** Optional post-success hook executed by the pipeline. */
  postSuccess?: DeployPostSuccess;
}

export interface DeployActionRequest extends BaseDeployRequest {
  action: 'deploy';
  composeContent: string;
  envContent: string;
  forceRecreate?: boolean;
}

export interface TeardownRequest extends BaseDeployRequest {
  action: 'teardown';
}

export type DeployRequest = DeployActionRequest | TeardownRequest;

export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  action: DeployAction;
  forceRecreate: boolean;
  logs: string | null;
  createdAt: Date;
  postSuccess: DeployPostSuccess | null;
}

export type {
  ManagedHost,
  HostCapabilities,
  HostStatus as ManagedHostStatus,
} from '@/lib/database/repositories/host-repository';

export interface ManifestEntry {
  host: string;
  autoDeploy: boolean;
}

export interface Manifest {
  stacks: Record<string, ManifestEntry>;
}

/** Secret resolution contract for the deploy pipeline executor. */
export interface SecretResolver {
  resolve(stack: string, variables: string[]): Promise<Record<string, string>>;
}

export interface AgentDeployPayload {
  stack: string;
  composeContent: string;
  envContent: string;
  action: DeployAction;
  forceRecreate?: boolean;
}

export interface AgentDeployResponse {
  success: boolean;
  logs: string;
}
