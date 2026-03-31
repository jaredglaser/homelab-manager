/**
 * Monaco editor setup: local workers + YAML language support.
 *
 * This file must only be imported dynamically from browser code (never from
 * tests) because it creates web workers via Vite's new URL() pattern.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';

// Use local monaco-editor package instead of CDN.
loader.config({ monaco });

// Monaco 0.53+ broke `editor.createWebWorker` for libraries that pass the
// legacy {label, createData, moduleId} options (e.g. monaco-worker-manager).
// The top-level `createWebWorker` from workers.js handles both old and new
// formats. Redirect until monaco-editor 0.56+ ships the upstream fix.
// See: https://github.com/remcohaszing/monaco-yaml/issues/272
const { createWebWorker: topLevelCreateWebWorker } = monaco as unknown as
  { createWebWorker: typeof monaco.editor.createWebWorker };
const origCreateWebWorker = monaco.editor.createWebWorker.bind(monaco.editor);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
monaco.editor.createWebWorker = (opts: any) =>
  'worker' in opts ? origCreateWebWorker(opts) : topLevelCreateWebWorker(opts);

// MonacoEnvironment.getWorker handles worker creation for both Monaco's
// built-in editor worker and the YAML language service worker.
window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    const url = label === 'yaml'
      ? new URL('./workers/yaml.worker.ts', import.meta.url)
      : new URL('./workers/editor.worker.ts', import.meta.url);
    return new Worker(url, { type: 'module' });
  },
};

// Configure YAML language features (hover, validation, folding, etc.)
// Schema is fetched at runtime from /compose-spec.json served by the app.
configureMonacoYaml(monaco, {
  enableSchemaRequest: true,
  schemas: [
    {
      uri: new URL('/compose-spec.json', window.location.origin).href,
      fileMatch: ['*'],
    },
  ],
});
