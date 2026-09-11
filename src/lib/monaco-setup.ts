/**
 * Monaco editor setup: local workers + YAML language support.
 *
 * This file must only be imported dynamically from browser code (never from
 * tests) because it creates web workers via Vite's new URL() pattern.
 */
// Minimal editor core. Deliberately NOT `import * as monaco from 'monaco-editor'`:
// that barrel pulls every basic-language registration plus the css/html/json/
// typescript language features (and their workers) — none of which this app
// uses. The compose editor is YAML-only, so the editor core + the yaml
// language definition are all we need.
// (Subpaths omit 'esm/vs' — the package exports wildcard prepends it.)
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { conf as yamlConf, language as yamlLanguage } from 'monaco-editor/languages/definitions/yaml/yaml.js';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';

// Use local monaco-editor package instead of CDN.
loader.config({ monaco });

// Register the YAML language ourselves (id/extension metadata comes from
// monaco-yaml's configureMonacoYaml below, but the tokenizer (syntax
// highlighting) and bracket/comment config come from Monaco's own yaml
// definition — normally pulled in by the barrel we no longer import).
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
// used by monaco-yaml). The full barrel used to paper over this via its
// re-export chain; the minimal editor.api import does not expose a top-level
// createWebWorker at all. Recreate the legacy adapter inline: spin up the
// worker through MonacoEnvironment.getWorker (keyed by label, see below),
// post the bootstrap sequence the legacy worker protocol expects, and hand
// the worker promise to editor.createWebWorker, which accepts {worker}.
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

// Workers are imported with Vite's ?worker suffix so each becomes a properly
// bundled, self-contained asset (the previous new URL(..., import.meta.url)
// pattern got compiled into a data: URL with an unresolvable bare-specifier
// import, which Chrome rejects — the worker errored before doing anything).
import YamlWorker from './workers/yaml.worker.ts?worker';
import EditorWorker from './workers/editor.worker.ts?worker';

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'yaml' ? new YamlWorker() : new EditorWorker();
  },
};

// Configure YAML language features (hover, validation, folding, etc.)
// Schema is fetched at runtime from /compose-spec.json served by the app.
// monaco-yaml re-registers the 'yaml' language id it already finds registered;
// its provider registrations (hover/completion/format) attach to it.
configureMonacoYaml(monaco, {
  enableSchemaRequest: true,
  schemas: [
    {
      uri: new URL('/compose-spec.json', window.location.origin).href,
      fileMatch: ['*'],
    },
  ],
});
