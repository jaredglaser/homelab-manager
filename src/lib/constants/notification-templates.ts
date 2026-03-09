type Severity = 'success' | 'error' | 'warning';

interface NotificationOutput {
  type: string;
  severity: Severity;
  title: string;
  message: string;
}

// ── Template Registry ────────────────────────────────────────────────
// Every notification the app can produce is defined here.
// To add a new notification: add a template below + a case in buildNotification.

export const NOTIFICATION_TEMPLATES = {
  containerUpdateSuccess: {
    type: 'container_update_success',
    severity: 'success' as Severity,
  },
  containerUpdateFailed: {
    type: 'container_update_failed',
    severity: 'error' as Severity,
  },
  containerUpdateTimeout: {
    type: 'container_update_timeout',
    severity: 'warning' as Severity,
  },
  stackRedeploySuccess: {
    type: 'stack_redeploy_success',
    severity: 'success' as Severity,
  },
  stackRedeployFailed: {
    type: 'stack_redeploy_failed',
    severity: 'error' as Severity,
  },
  stackRedeployTimeout: {
    type: 'stack_redeploy_timeout',
    severity: 'warning' as Severity,
  },
  containerRecoveryFailed: {
    type: 'container_recovery_failed',
    severity: 'error' as Severity,
  },
} as const;

export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

// ── Parameter types per template key ─────────────────────────────────

interface TemplateParams {
  containerUpdateSuccess: { name: string; tag: string };
  containerUpdateFailed: { name: string; step: string; error: string };
  containerUpdateTimeout: { name: string; step: string };
  stackRedeploySuccess: { stackName: string };
  stackRedeployFailed: { stackName: string; error: string };
  stackRedeployTimeout: { stackName: string };
  containerRecoveryFailed: { name: string; error: string };
}

// ── Builder ──────────────────────────────────────────────────────────

export function buildNotification<K extends NotificationTemplateKey>(
  key: K,
  params: TemplateParams[K],
): NotificationOutput {
  const template = NOTIFICATION_TEMPLATES[key];

  switch (key) {
    case 'containerUpdateSuccess': {
      const p = params as TemplateParams['containerUpdateSuccess'];
      return {
        ...template,
        title: `${p.name} updated successfully`,
        message: `${p.name} is now running ${p.tag}.`,
      };
    }
    case 'containerUpdateFailed': {
      const p = params as TemplateParams['containerUpdateFailed'];
      return {
        ...template,
        title: `${p.name} update failed`,
        message: `Failed during ${p.step}: ${p.error}. Check container status in the Docker view.`,
      };
    }
    case 'containerUpdateTimeout': {
      const p = params as TemplateParams['containerUpdateTimeout'];
      return {
        ...template,
        title: `${p.name} update timed out`,
        message: `Timed out during ${p.step}. Check container status in the Docker view — the update may still be in progress.`,
      };
    }
    case 'stackRedeploySuccess': {
      const p = params as TemplateParams['stackRedeploySuccess'];
      return {
        ...template,
        title: `${p.stackName} redeployed successfully`,
        message: `Stack ${p.stackName} has been redeployed with the latest images.`,
      };
    }
    case 'stackRedeployFailed': {
      const p = params as TemplateParams['stackRedeployFailed'];
      return {
        ...template,
        title: `${p.stackName} redeploy failed`,
        message: `${p.error}. Check Portainer UI for details and retry from the Stacks view.`,
      };
    }
    case 'stackRedeployTimeout': {
      const p = params as TemplateParams['stackRedeployTimeout'];
      return {
        ...template,
        title: `${p.stackName} redeploy timed out`,
        message: `Operation timed out but Portainer may still be working. Check Portainer UI for status.`,
      };
    }
    case 'containerRecoveryFailed': {
      const p = params as TemplateParams['containerRecoveryFailed'];
      return {
        ...template,
        title: `${p.name} recovery failed`,
        message: `Failed to restart old container after update failure: ${p.error}. Manual intervention required — check the Docker view.`,
      };
    }
    default:
      throw new Error(`Unknown notification template: ${key}`);
  }
}
