export { DeployPipeline } from './pipeline';
export { GitTriggerBuilder, UITriggerBuilder } from './builders';
export { NoOpSecretResolver, extractVariableReferences } from './secret-resolver';
export { computeHash, detectChanges } from './change-detection';
export { isDockerManagementEnabled } from './feature-flag';
export type {
  DeployAction,
  DeployStatus,
  DeployTrigger,
  DeployRequest,
  DeployRecord,
  ManagedHost,
  Manifest,
  ManifestEntry,
  SecretResolver,
  AgentDeployPayload,
  AgentDeployResponse,
} from './types';
