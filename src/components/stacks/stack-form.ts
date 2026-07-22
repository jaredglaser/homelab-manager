/**
 * Shared shape for the stack editor form. A single react-hook-form instance in
 * StackEditorForm holds both the compose draft and every secret value, so edits
 * survive tab switches (RHF keeps field state for unmounted inputs) and a single
 * `isDirty` drives the tab dots and the leave-guard.
 *
 * Secret field paths are `secrets.<name>`. Variable names come from compose
 * `${VAR}` references (see parse-variables), which never start with a digit, so
 * RHF never mistakes a secret key for an array index.
 */
export interface StackFormValues {
  compose: string;
  secrets: Record<string, string>;
}

export function secretFieldName(variableName: string): `secrets.${string}` {
  return `secrets.${variableName}`;
}
