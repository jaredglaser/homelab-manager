export type SettingsWireMessage =
  | { type: 'init'; settings: Record<string, string> }
  | { type: 'change'; key: string; value: string };
