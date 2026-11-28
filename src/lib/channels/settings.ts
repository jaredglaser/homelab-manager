import { z } from 'zod';
import { SETTINGS_TOPIC, USER_SETTINGS_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';

const zSettingsWireMessage = z.union([
  z.object({ type: z.literal('init'), settings: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('change'), key: z.string(), value: z.string() }),
]);

export const settingsChannel: MuxChannel<typeof zSettingsWireMessage> = {
  topic: SETTINGS_TOPIC,
  schema: zSettingsWireMessage,
};

/** The server picks the user from the connection's session, so the topic carries no user id. */
export const userSettingsChannel: MuxChannel<typeof zSettingsWireMessage> = {
  topic: USER_SETTINGS_TOPIC,
  schema: zSettingsWireMessage,
};
