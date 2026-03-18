export { DeployPipeline } from './pipeline';
export { GitTriggerBuilder, UITriggerBuilder } from './builders';
export { NoOpSecretResolver, extractVariableReferences } from './secret-resolver';
export { computeHash, detectChanges } from './change-detection';
export type { ChangeDetectionResult } from './change-detection';
export { isDockerManagementEnabled } from './feature-flag';
export type {
  DeployAction,
  DeployStatus,
  DeployTrigger,
  DeployRequest,
  DeployActionRequest,
  TeardownRequest,
  RestartRequest,
  DeployRecord,
  ManagedHost,
  ManagedHostStatus,
  Manifest,
  ManifestEntry,
  SecretResolver,
  AgentDeployPayload,
  AgentDeployResponse,
} from './types';
