import { describe, it, expect } from 'bun:test';
import { NOTIFICATION_TEMPLATES, buildNotification } from '../notification-templates';

describe('NOTIFICATION_TEMPLATES', () => {
  it('should define all expected template keys', () => {
    expect(NOTIFICATION_TEMPLATES.containerUpdateSuccess).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.containerUpdateFailed).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.containerUpdateTimeout).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.stackRedeploySuccess).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.stackRedeployFailed).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.stackRedeployTimeout).toBeDefined();
    expect(NOTIFICATION_TEMPLATES.containerRecoveryFailed).toBeDefined();
  });

  it('should have valid severity values', () => {
    for (const template of Object.values(NOTIFICATION_TEMPLATES)) {
      expect(['success', 'error', 'warning']).toContain(template.severity);
    }
  });
});

describe('buildNotification', () => {
  it('should build containerUpdateSuccess notification', () => {
    const n = buildNotification('containerUpdateSuccess', { name: 'nginx', tag: 'v1.26' });
    expect(n.type).toBe('container_update_success');
    expect(n.severity).toBe('success');
    expect(n.title).toContain('nginx');
    expect(n.message).toContain('v1.26');
  });

  it('should build containerUpdateFailed notification', () => {
    const n = buildNotification('containerUpdateFailed', {
      name: 'nginx', step: 'image pull', error: 'timeout',
    });
    expect(n.type).toBe('container_update_failed');
    expect(n.severity).toBe('error');
    expect(n.title).toContain('nginx');
    expect(n.message).toContain('image pull');
    expect(n.message).toContain('timeout');
  });

  it('should build stackRedeploySuccess notification', () => {
    const n = buildNotification('stackRedeploySuccess', { stackName: 'media-stack' });
    expect(n.type).toBe('stack_redeploy_success');
    expect(n.severity).toBe('success');
    expect(n.title).toContain('media-stack');
  });

  it('should build stackRedeployFailed notification', () => {
    const n = buildNotification('stackRedeployFailed', {
      stackName: 'media-stack', error: 'Portainer API 500',
    });
    expect(n.type).toBe('stack_redeploy_failed');
    expect(n.severity).toBe('error');
    expect(n.message).toContain('Portainer API 500');
  });

  it('should build containerUpdateTimeout notification', () => {
    const n = buildNotification('containerUpdateTimeout', {
      name: 'nginx', step: 'recreate',
    });
    expect(n.type).toBe('container_update_timeout');
    expect(n.severity).toBe('warning');
    expect(n.message).toContain('recreate');
  });

  it('should build stackRedeployTimeout notification', () => {
    const n = buildNotification('stackRedeployTimeout', { stackName: 'media-stack' });
    expect(n.type).toBe('stack_redeploy_timeout');
    expect(n.severity).toBe('warning');
  });

  it('should build containerRecoveryFailed notification', () => {
    const n = buildNotification('containerRecoveryFailed', {
      name: 'nginx', error: 'container gone',
    });
    expect(n.type).toBe('container_recovery_failed');
    expect(n.severity).toBe('error');
    expect(n.message).toContain('container gone');
  });
});
