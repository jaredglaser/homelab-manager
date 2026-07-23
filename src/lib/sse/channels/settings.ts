import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { SettingsSSEMessage } from '@/types/settings';

const zSettingsWireMessage = z.union([
  z.object({ type: z.literal('init'), settings: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('change'), key: z.string(), value: z.string() }),
]);

export const settingsChannel = defineSseChannel({
  url: '/api/settings',
  errorEvent: 'settings_error',
  schema: zSettingsWireMessage,
  revive: (message): SettingsSSEMessage => message,
});
