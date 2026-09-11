/**
 * Type declarations for deep monaco-editor ESM subpaths the app imports
 * directly. The package's exports wildcard has no `types` condition, so TS
 * can't find the sibling .d.ts files on its own.
 */
declare module 'monaco-editor/languages/definitions/yaml/yaml.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
