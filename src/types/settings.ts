/** Discriminated union for settings SSE messages */
export type SettingsSSEMessage =
  | { type: 'init'; settings: Record<string, string> }
  | { type: 'change'; key: string; value: string };
