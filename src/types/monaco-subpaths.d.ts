// The package's exports wildcard has no `types` condition, so TS cannot resolve these deep subpaths on its own.
declare module 'monaco-editor/languages/definitions/yaml/yaml.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
