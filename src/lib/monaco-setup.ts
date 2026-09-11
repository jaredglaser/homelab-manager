/**
 * Monaco editor setup: local workers + YAML language support.
 *
 * This file must only be imported dynamically from browser code (never from
 * tests) because it creates web workers.
 */
// Subpaths omit 'esm/vs'; the package exports wildcard prepends it.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { conf as yamlConf, language as yamlLanguage } from 'monaco-editor/languages/definitions/yaml/yaml.js';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';

// Use local monaco-editor package instead of CDN.
loader.config({ monaco });

monaco.languages.register({
  id: 'yaml',
  extensions: ['.yaml', '.yml'],
  aliases: ['YAML', 'yaml', 'YML', 'yml'],
  mimetypes: ['application/x-yaml'],
});
monaco.languages.setLanguageConfiguration('yaml', yamlConf);
monaco.languages.setMonarchTokensProvider('yaml', yamlLanguage);

// Monaco 0.53+ broke `editor.createWebWorker` for libraries that pass the
// legacy {label, createData, moduleId} options (e.g. monaco-worker-manager,
// used by monaco-yaml).
// See: https://github.com/remcohaszing/monaco-yaml/issues/272
const origCreateWebWorker = monaco.editor.createWebWorker.bind(monaco.editor);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
monaco.editor.createWebWorker = (opts: any) => {
  if ('worker' in opts) return origCreateWebWorker(opts);
  const env = window.MonacoEnvironment;
  if (!env?.getWorker) throw new Error('MonacoEnvironment.getWorker must be defined');
  const worker = Promise.resolve(env.getWorker('workerMain.js', opts.label ?? 'monaco-editor-worker')).then((w: Worker) => {
    w.postMessage('ignore');
    w.postMessage(opts.createData);
    return w;
  });
  return origCreateWebWorker({
    worker,
    host: opts.host,
    keepIdleModels: opts.keepIdleModels,
  });
};

// ?worker, not new URL(..., import.meta.url), so each worker bundles as a self-contained asset.
import YamlWorker from './workers/yaml.worker.ts?worker';
import EditorWorker from './workers/editor.worker.ts?worker';

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'yaml' ? new YamlWorker() : new EditorWorker();
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
