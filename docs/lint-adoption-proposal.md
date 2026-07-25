# Lint Adoption Proposal

Status: research deliverable. Nothing in this document has been installed, configured, or committed beyond the document itself.

Every violation count below was **measured**, not estimated: ESLint 10.8.0 with typescript-eslint 8.65.0 was installed in a scratch directory outside the repo and run against this worktree at `d2e3e4f`. Where a number is projected rather than measured, it says so.

---

## 1. Recommendation in one paragraph

Adopt **ESLint 10 with typescript-eslint**, flat config, one config file at the repo root covering all three packages, no formatter, no plugin beyond `eslint-plugin-react-hooks` and the two first-party TanStack plugins. Gate it in CI as its own job from day one. The deciding factor is not speed or ergonomics: it is that the SSE seam rule is expressible as five `no-restricted-syntax` selectors in plain config, and ESLint is the only one of the three candidates where that is true today.

---

## 2. Tool choice

### Winner: ESLint 10.8.0 + typescript-eslint 8.65.0

| Requirement | Verdict |
| --- | --- |
| Custom structural rules without a plugin | `no-restricted-syntax` + esquery selectors. Confirmed not deprecated in v10 ([rule docs on `main`](https://raw.githubusercontent.com/eslint/eslint/main/docs/src/rules/no-restricted-syntax.md), no `deprecated` frontmatter; absent from the [v10 migration guide](https://raw.githubusercontent.com/eslint/eslint/main/docs/src/use/migrate-to-10.0.0.md)) |
| Custom rules needing more than a selector | Inline virtual plugin in flat config, no package to publish. Validated in this repo (see rule 14/15 below) |
| Type-aware rules on **TypeScript 6.0.3** | Supported. typescript-eslint 8.65.0 peer range is `typescript: ">=4.8.4 <6.1.0"`, confirmed in [`warnAboutTSVersion.ts`](https://raw.githubusercontent.com/typescript-eslint/typescript-eslint/main/packages/typescript-estree/src/parseSettings/warnAboutTSVersion.ts). No warning, no error |
| Speed at this size | Measured: 42s type-aware on 590 files; 0.85s for the SSE seam rules alone (no type info needed) |
| Bun compatibility | `bun run lint` / `bunx eslint` spawn Node via the `#!/usr/bin/env node` shebang, which is the supported path. Do not use `bun --bun eslint` |
| Two/three independent packages | ESLint 10 `basePath` (added in [9.30.0](https://eslint.org/blog/2025/06/eslint-v9.30.0-released/)) plus per-block `tsconfigRootDir`. No workspace needed |

### Losers, and why

**oxlint 1.75.0 loses on two independent counts.** It has no native `no-restricted-syntax`; a maintainer [declined to add selector support](https://github.com/oxc-project/oxc/discussions/11649) and pointed at JS plugins. The first-party `oxlint-plugin-eslint` does provide `eslint-js/no-restricted-syntax` with full esquery, but it runs through the `jsPlugins` mechanism, which oxlint's own shipped config schema labels *"in alpha and not subject to semver."* Betting the replacement for a deleted test on an explicitly non-semver alpha is the wrong trade. Separately, oxlint's type-aware engine ([`oxlint-tsgolint`](https://github.com/oxc-project/tsgolint), v7.0.2001) bundles its own **TypeScript 7** and does not use your installed compiler. This project is on TS 6.0.3, so type-aware oxlint is gated behind a TS 7 migration. Revisit when both conditions clear; on a 600-file repo the speed win is seconds, not minutes.

**Biome 2.5.5 loses outright on the hard requirement.** It has no AST-selector rule of any kind (its restricted-\* family is `noRestrictedImports`, `noRestrictedGlobals`, `noRestrictedTypes`). Custom structural rules must go through GritQL, whose reference docs still carry the warning *"bugs are still expected and some features are still outright missing"* alongside *"Biome's grammar can change between versions... which could break your patterns."* GritQL also matches only a curated subset of TreeSitter node names; TS-specific nodes cannot be targeted at all ([#7363](https://github.com/biomejs/biome/issues/7363)). Its type-aware `types` domain is mostly nursery and self-reports roughly 75% parity with typescript-eslint on `noFloatingPromises`.

**The oxlint+ESLint hybrid loses on sprawl.** `eslint-plugin-oxlint` is real and maintained, but it means two linters, two configs, two rule vocabularies, and a version pin coupling them, to save perhaps 20 seconds on a 600-file repo. Wrong trade for a solo maintainer.

---

## 3. Dependencies (exact pins, per the no-caret convention)

Add to the **root** `package.json` `devDependencies` only. Do not add lint deps to `agent/package.json` or `agent-updater/package.json`: their lockfiles are what the Docker builds see, and linting is a dev-time concern.

```json
"@eslint/js": "10.0.1",
"@tanstack/eslint-plugin-query": "5.101.4",
"@tanstack/eslint-plugin-router": "1.162.0",
"eslint": "10.8.0",
"eslint-plugin-react-hooks": "7.1.1",
"globals": "17.7.0",
"typescript-eslint": "8.65.0"
```

Seven entries. `@eslint/js` and `globals` are near-zero-cost standard companions. The two TanStack plugins each declare a single dependency, `@typescript-eslint/utils`, which typescript-eslint already brings, so their marginal install cost is close to nothing. `eslint-plugin-react-hooks` is the heaviest addition (roughly 42 transitive, including Babel and hermes-parser, because it runs the React Compiler); it is also the only one that catches real bugs in this codebase's React layer, so it earns the weight.

### Deliberately not recommended

| Package | Reason |
| --- | --- |
| `eslint-plugin-jsx-a11y` | Latest is **6.10.2, published 2024-10-26**. Peer range is `^3 \|\| ... \|\| ^9`, so it does **not** declare ESLint 10 ([#1075](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/issues/1075) open, PRs unmerged). I confirmed the peer conflict by attempting the install: npm refused with ERESOLVE. Roughly 126 net-new packages. It also only checks lowercase DOM elements by default, so on a Base UI codebase it is largely blind to the component layer anyway. The e18e fork `eslint-plugin-jsx-a11y-x` fixes the peer range and the bloat but is at 0.2.0 with very low adoption |
| `eslint-plugin-react` | 7.37.5, no release in ~15 months, and **actually broken on ESLint 10** ([#3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977): `contextOrFilename.getFilename is not a function`). ~121 transitive deps. Wrong era for a codebase with no PropTypes and no class components |
| `eslint-plugin-react-compiler` | Dead. Merged into `eslint-plugin-react-hooks` at v6.1.0. No stable release |
| `eslint-plugin-security` | Maintained, but duplicates SonarQube Cloud's taint analysis with strictly weaker precision (single-file AST matching vs source-to-sink dataflow), at a measured ~1:1 true-to-false-positive ratio. You already pay for Sonar |
| Any SQL-injection ESLint plugin | All are "is there an interpolation in a string that looks like SQL" heuristics that cannot distinguish an interpolated table name from user input. Sonar already traces SQL injection across files |
| `eslint-plugin-import-x` | The genuinely useful part is `no-cycle`, which nothing in core or typescript-eslint replaces. But it is ~10 real packages for one rule, and `madge`/`dpdm` gives cycle detection as a standalone step with zero lint plugins. Defer; see section 10 |
| `eslint-plugin-tailwindcss` | The strongest deferred candidate. 4.2.0 is Tailwind-v4-native and needs no JS config (`cssConfigPath` points at `App.css`), peer includes ESLint 10. But ~26 net packages, and rule 1's actual violation count in this repo is zero. Revisit if class churn becomes a review burden |
| Any formatter | See section 11 |

---

## 4. Config files

One config file at the repo root: **`eslint.config.mjs`**. Not `.ts`: ESLint would load a TS config through jiti under Node, adding a dependency and a moving part for no benefit.

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginRouter from '@tanstack/eslint-plugin-router';
import globals from 'globals';

// CLAUDE.md rules 14 and 15 applied to comment text. Comments are not AST nodes,
// so no-restricted-syntax cannot reach them; this is the smallest thing that can.
const BANNED_COMMENT_PROSE = [
  [/[—–]/, 'an em dash or en dash'],
  [/\b(delve|tapestry|intricate|robust|comprehensive|meticulous|leverage|utilize|facilitate)\b/i, 'banned vocabulary'],
  [/\bit's (worth|important to) not(e|ing)\b/i, 'a banned filler phrase'],
  [/\b(essentially|fundamentally|carefully|thoroughly|comprehensively)\b/i, 'a performative qualifier'],
  [/(?:^|\s)#\d{2,5}\b/, 'a bare issue or PR reference, which belongs in the commit message'],
];

const localRules = {
  'no-claudisms-in-comments': {
    meta: { type: 'problem', schema: [] },
    create(context) {
      return {
        Program() {
          for (const c of context.sourceCode.getAllComments()) {
            for (const [re, label] of BANNED_COMMENT_PROSE) {
              if (re.test(c.value)) {
                context.report({ loc: c.loc, message: `Comment contains ${label}. See CLAUDE.md rules 14 and 15.` });
                break;
              }
            }
          }
        },
      };
    },
  },
};

const SSE_SEAM_RESTRICTIONS = [ /* verbatim from section 6 */ ];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.output/**',
      '**/dist/**',
      'public/**',
      'src/routeTree.gen.ts',   // CLAUDE.md rule 9: generated, never edited
      '.claude/**',
      '.codex/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Root package: web + worker + scripts.
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'server/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { local: localRules },
  },

  // agent/ and agent-updater/: independent packages, independent tsconfigs, no workspace.
  {
    files: ['agent/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/agent` },
      globals: { ...globals.node },
    },
    plugins: { local: localRules },
  },
  {
    files: ['agent-updater/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/agent-updater` },
      globals: { ...globals.node },
    },
    plugins: { local: localRules },
  },

  // React layer only.
  {
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,   // single object, do NOT spread as an array
  },
  ...pluginQuery.configs['flat/recommended'],
  ...pluginRouter.configs['flat/recommended'],

  // ---- Bucket 1 + 2: error ----
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // CLAUDE.md rule 1: no local .css files. Package CSS (xterm, fontsource) stays allowed.
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['./*.css', '../*.css', '@/**/*.css'], message: 'TailwindCSS only. The single allowed stylesheet is src/App.css (CLAUDE.md rule 1).' }],
      }],

      'local/no-claudisms-in-comments': 'warn',
    },
  },

  // CLAUDE.md rule 2: @/ outside __tests__, relative only within the same __tests__ dir.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['../*'], message: 'Use the @/ alias for src imports outside __tests__ (CLAUDE.md rule 2).' },
          { group: ['./*.css', '@/**/*.css'], message: 'TailwindCSS only (CLAUDE.md rule 1).' },
        ],
      }],
    },
  },

  // CLAUDE.md rule 5 + the SSE seam. No type information required.
  {
    files: ['src/routes/api/**/*.ts', 'agent/src/routes/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'no-restricted-syntax': ['error', ...SSE_SEAM_RESTRICTIONS] },
  },

  // CLAUDE.md rule 7: no bare setTimeout awaits in tests.
  {
    files: ['**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "AwaitExpression > NewExpression[callee.name='Promise'] > :function CallExpression[callee.name='setTimeout']",
        message: 'Do not await a bare setTimeout to let async settle (CLAUDE.md rule 7). Await a deterministic signal, use waitFor/findBy*, or spy on globalThis.setTimeout.',
      }],
    },
  },
  { files: ['src/lib/test/wait-for-condition.ts'], rules: { 'no-restricted-syntax': 'off' } },

  // CLAUDE.md rule 8.
  {
    files: ['src/**/*.{ts,tsx}', 'agent/src/**/*.ts', 'agent-updater/src/**/*.ts'],
    rules: { 'no-console': ['warn', { allow: ['error', 'info', 'warn'] }] },
  },

  // ---- Bucket 3: warn ----
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
    },
  },
);
```

Scripts for the root `package.json`:

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"lint:sse": "eslint src/routes/api agent/src/routes"
```

`lint:sse` exists because the seam rules need no type information and run in under a second, which makes them cheap to invoke from a hook or locally.

---

## 5. The three buckets

All counts measured on this worktree. "non-test" excludes `__tests__/` and `src/lib/test/`.

### Bucket 1: error, autofixable, turn on now

`eslint . --fix` resolves all of these in one pass.

| Rule | Total | Note |
| --- | ---: | --- |
| `@typescript-eslint/no-unnecessary-type-assertion` | 321 | 304 are in test files (redundant mock casts) |
| `@typescript-eslint/return-await` | 90 | 87 autofixable, 3 need a look |
| `@typescript-eslint/no-import-type-side-effects` | 4 | |
| `@typescript-eslint/no-duplicate-type-constituents` | 3 | |
| `prefer-const` | 2 | |
| **Total** | **420** | one `--fix` commit |

I deliberately **excluded** `tseslint.configs.stylisticTypeChecked`. It adds another ~430 autofixable findings (`array-type` 45, `dot-notation` 26, `prefer-template` 21, `consistent-type-definitions` 17, `no-inferrable-types` 11, `non-nullable-type-assertion-style` 16, and similar). Those are taste, not correctness, and 430 more lines of diff in the adoption PR buys nothing. Add the tier later if the maintainer wants it.

Be aware that 420 autofixes is still a large diff to review. It is mechanical and reviewable in one sitting, but it should be its own commit, separate from the config.

### Bucket 2: error, not autofixable, currently clean

Measured at **zero violations**. These are pure regression insurance and cost nothing to enable.

| Rule | Count | Why it matters here |
| --- | ---: | --- |
| All 5 SSE seam selectors (`src/routes/api/**`) | 0\* | \*One exception, below |
| `@tanstack/query/exhaustive-deps` | 0 | queryKey missing a closed-over variable is a silent cache collision |
| `@tanstack/query/stable-query-client` | 0 | CLAUDE.md rule 9 already mandates the singleton; this makes it structural |
| `@tanstack/query/no-unstable-deps` | 0 | query result in a dep array causes render loops. Directly relevant to the streaming hooks |
| `@tanstack/query/no-void-query-fn` | 0 | |
| `@tanstack/query/infinite-query-property-order` | 0 | |
| `@tanstack/query/mutation-property-order` | 0 | |
| `@tanstack/query/no-rest-destructuring` | 0 | warn by default upstream |
| `@tanstack/router/route-param-names` | 0 | |
| `eqeqeq` | 0 | |
| `no-var` | 0 | |
| `no-restricted-imports` (local `.css`) | 0 | the only `.css` imports are from packages (xterm, fontsource) and stay allowed |
| `react-hooks/rules-of-hooks` (non-test) | 0 | 2 in test files |

Every one of the eight TanStack Query rules is already clean. That is a strong argument for the plugin: it is free today and stops a class of cache bug that produces wrong data rather than a crash.

**Two near-clean rules worth turning on with a one-line fix each:**

- `@tanstack/router/create-route-property-order`: **1 violation**, `src/routes/login.tsx:5`. Wrong property order silently degrades type inference with no TypeScript error, which is exactly the invisible-failure class the maintainer cares about.
- SSE seam rule 3: **1 violation**, `src/routes/api/settings.ts:17`, which inlines `` serialize: (message) => `data: ${JSON.stringify(message)}\n\n` ``. Its sibling `stack-status.ts` already delegates to `serializeStackStatusEvent` imported from the channel module, which is outside the route glob and therefore clean. The fix is to move the settings serializer into `src/lib/sse/channels/settings.ts` the same way, which makes the two broadcast routes consistent. This is the rule driving convergence, not a false positive.

### Bucket 3: warn for now, real cleanup exists

| Rule | Total | Non-test | Comment |
| --- | ---: | ---: | --- |
| `@typescript-eslint/no-empty-function` | 757 | 20 | almost entirely `() => {}` mock stubs |
| `@typescript-eslint/require-await` | 625 | 39 | |
| `@typescript-eslint/no-unsafe-member-access` | 623 | 54 | the `any`-flow family below is concentrated in tests |
| `@typescript-eslint/no-explicit-any` | 501 | 9 | already net of 60 existing disable comments |
| `@typescript-eslint/no-unsafe-argument` | 462 | 39 | |
| `@typescript-eslint/no-unsafe-assignment` | 327 | 28 | |
| `@typescript-eslint/no-floating-promises` | 233 | 23 | **see note** |
| `@typescript-eslint/no-unsafe-call` | 214 | 3 | |
| `@typescript-eslint/await-thenable` | 171 | 0 | all in tests |
| `@typescript-eslint/no-unnecessary-condition` | 145 | 119 | highest genuine non-test signal in the table |
| `@typescript-eslint/no-unused-vars` | 118 | 21 | |
| `@typescript-eslint/unbound-method` | 110 | 1 | |
| `@typescript-eslint/consistent-type-imports` | 51 | 13 | **see note** |
| `react-hooks/refs` | 43 | 43 | ref written during render, e.g. `prevStatsRef.current = next` inside a `useMemo` in `ContainerTable.tsx` |
| `no-console` | 42 | 16 | **see note** |
| `@typescript-eslint/no-unsafe-return` | 26 | 2 | |
| `react-hooks/set-state-in-effect` | 11 | 11 | classic real-bug rule |
| `@typescript-eslint/no-misused-promises` | 7 | 7 | |
| `react-hooks/exhaustive-deps` | 4 | 4 | |
| `react-hooks/incompatible-library` | 4 | 2 | |
| `react-hooks/purity` | 2 | 2 | |
| `react-hooks/use-memo` | 2 | 2 | |

Three of these need a considered decision rather than a blanket promotion later:

- **`no-floating-promises` (23 non-test).** This codebase has deliberate fire-and-forget async. The rule is satisfied by an explicit `void` operator, so the cleanup is to mark intent rather than to change behavior. That is worth doing, but it is 23 judgment calls, not a mechanical pass.
- **`consistent-type-imports` (13 non-test).** Higher stakes than the count suggests. Web and worker import **only types** from the agent through the `@homelab-manager/agent/*` path alias, with no runtime dependency. A value import across that boundary is a real defect that would only surface at build or run time. Recommend promoting this one to error early, scoped to imports from `@homelab-manager/agent/*`, once the 13 are cleared.
- **`no-console` (16 non-test).** The rule as configured allows `error`/`info`/`warn`. Of the 16, most are legitimate operational logging that should simply become `console.info` (`src/lib/database/migrate.ts` has 6, `src/worker/collectors/base-collector.ts` has 4) or are already `debug`-gated (`useEventSource.ts`, `useTimeSeriesStream.ts`). Small, clear cleanup.

### A trap the implementing agent must handle first

The repo already contains **71 `eslint-disable` comments** despite having no linter. Broken down: `@typescript-eslint/no-explicit-any` 60, `react-hooks/exhaustive-deps` 6, `@typescript-eslint/no-unsafe-return` 2, `import/first` 1, `@typescript-eslint/only-throw-error` 1. (14 non-test, 57 in tests.)

A disable directive naming a rule that is not configured is a **hard error**, not a warning. I measured 70 such errors when running a config that omitted those rules. The recommended config enables all of them except `import/first`, which belongs to an import plugin this proposal does not adopt. **Delete that single comment in `src/components/settings/__tests__/AuthManagementCard.test.tsx:21` rather than adding a plugin for it.**

---

## 6. The SSE seam rule, verbatim

This is the hard requirement. All five shapes from the specification are expressible in `no-restricted-syntax` with no custom plugin, and all five were validated empirically.

```js
const SSE_SEAM_RESTRICTIONS = [
  {
    selector: "NewExpression[callee.name='ReadableStream']",
    message:
      'SSE routes must build their Response with createSseStream(). A hand-rolled ReadableStream silently drops the heartbeat, the initial flush, and abort teardown.',
  },
  {
    selector:
      "Property[key.value=/^content-type$/i] > Literal[value=/^text\\/event-stream/], Property[key.name=/^[Cc]ontent-?[Tt]ype$/] > Literal[value=/^text\\/event-stream/], Property[key.value=/^content-type$/i] > TemplateLiteral > TemplateElement[value.cooked=/^text\\/event-stream/]",
    message:
      'Do not set the SSE Content-Type by hand. Return createSseStream(request, { onStart }); the seam owns the response headers.',
  },
  {
    selector:
      "Literal[value=/^(data|event|id|retry):\\s/], Literal[value=/^:[^\\n]*\\n\\n$/], TemplateLiteral > TemplateElement[value.cooked=/^(data|event|id|retry):\\s/], TemplateLiteral > TemplateElement[value.cooked=/^:[^\\n]*\\n\\n$/]",
    message:
      'Hand-written SSE frame grammar. Use the SseEmitter from createSseStream(): emit.data(payload), emit.event(name, payload), or emit.raw(chunk) for already-framed upstream bytes.',
  },
  {
    selector: "CallExpression[callee.name='setInterval']",
    message:
      'Routes must not run their own timer. createSseStream() already owns the heartbeat; a second interval is a duplicate heartbeat that will drift. If a route genuinely needs a timer, add an eslint-disable-next-line with a reason.',
  },
  {
    selector:
      "CallExpression[callee.name='createSseStream'] Property[key.name='heartbeatMs']:not([value.type='Literal'][value.value>0][value.value<10000])",
    message:
      'heartbeatMs must be a numeric literal between 1 and 9999. The Bun default HTTP idleTimeout is 10s, so a slower (or disabled) heartbeat fails to prevent the very disconnect it exists to prevent.',
  },
];
```

Applied with:

```js
{
  files: ['src/routes/api/**/*.ts', 'agent/src/routes/**/*.ts'],
  ignores: ['**/__tests__/**'],
  rules: { 'no-restricted-syntax': ['error', ...SSE_SEAM_RESTRICTIONS] },
}
```

### Validation performed

A fixture exercising every shape plus every legitimate counter-case was linted. Results:

- **13 findings, all intended**: 1 raw `ReadableStream`; 3 content-type spellings (`'Content-Type'`, `'content-type'`, `ContentType`); 4 frame-grammar literals (`data:`, `event:`, `retry:`, `: ok\n\n`); 1 `setInterval`; 4 `heartbeatMs` escapes (`0`, `60000`, `10000` at the excluded boundary, and a non-literal `Number(...)`).
- **Zero false positives** on the legitimate cases: `heartbeatMs: 5000` passes; `createSseStream` with no `heartbeatMs` passes; `setTimeout` passes; a non-SSE `'Content-Type': 'text/plain'` passes; and critically, **`emit.raw(value)` with a non-literal `Uint8Array` passes**, which is what `src/routes/api/docker-logs.$containerId.ts` does when forwarding upstream agent bytes.

Against the real tree at `d2e3e4f`:

- `src/routes/api/**`: **1 finding**, `settings.ts:17`, discussed in bucket 2. The `docker-logs.$containerId.ts` pass-through and `stack-status.ts` are clean.
- `agent/src/routes/**`: **22 findings** across the 4 hand-rolled routes (`logs.ts` 10, `containers-events.ts` 4, `stats.ts` 4, `zfs.ts` 3). These are the pre-port state of this worktree. Once the companion PR porting `agent/src/lib/sse-stream.ts` lands, this should go to zero, and the rule becomes the thing that keeps it there. **The implementing agent must re-run `lint:sse` after rebasing onto that PR and confirm zero.**

Note that shape 4 already earns its place: `agent/src/routes/logs.ts:153` and `containers-events.ts:130` both run their own `setInterval` heartbeat today, which is precisely the drift the seam exists to prevent.

An escape hatch is `// eslint-disable-next-line no-restricted-syntax -- <reason>`, which is greppable and shows up in review, unlike silence.

---

## 7. What else in CLAUDE.md becomes enforceable

Classification of every numbered Critical Rule.

| Rule | Mechanism | Status |
| --- | --- | --- |
| 1 no `.css` files | `no-restricted-imports` on `./*.css`, `@/**/*.css` | **Enforceable, 0 violations.** Proxy only: lint sees imports, not file creation. An orphan `.css` file that nothing imports is invisible |
| 1 no hardcoded hex | not worth doing | **Measured 0 genuine violations.** All 15 hex-bearing lines are in `src/hooks/useLightPaletteEffect.ts`, which is the sanctioned palette-definition site CLAUDE.md itself describes. The only other 2 matches were `#322` and `#262` issue refs in comments, i.e. false positives for a naive regex. A rule here would be 100% false positives |
| 2 `@/` outside `__tests__` | `no-restricted-imports` `patterns: ['../*']` scoped to non-test src | **Enforceable, 10 violations.** Banning `./` same-directory imports too would be 80 violations for little value; recommend banning parent traversal only |
| 3 server fns via `createServerFn` | custom rule, not worth it | Would need to model middleware injection. Low value |
| 4 dynamic `await import()` for server-only modules | `no-restricted-imports` on `pg`, `@/lib/database/*`, `@/lib/database/subscription-service` scoped to `src/routes/api/**` and server-fn files | **Enforceable as a static-import ban.** Not proposed above only to keep the first PR small; this is the strongest addition for a follow-up. It catches the `node:async_hooks` client-bundle break structurally |
| 5 SSE pattern | the seam rule, section 6 | **Enforceable.** The div-vs-`<table>` half is separately expressible as `no-restricted-syntax` on `JSXOpeningElement[name.name=/^(table\|tr\|td)$/]` inside the datatable directory |
| 6 prefer editing over creating | not enforceable | Process, not code |
| 7 no bare `setTimeout` awaits in tests | `no-restricted-syntax`, scoped to `__tests__` | **Enforceable, 4 violations**, all genuine: `useTimeSeriesStream.test.ts:295`, `subscription-service.test.ts:79`, `deploy-watchdog.test.ts:270`, `host-collector-manager.test.ts:395`. Three are literally `setTimeout(r, 0)`. Requires exempting `src/lib/test/wait-for-condition.ts`, which is the sanctioned polling helper. The other 12 raw matches are legitimate sleeps in non-test code, so the glob scoping is what makes this rule usable |
| 8 no committed `console.log` | `no-console` with `allow: ['error','info','warn']` | **Enforceable, 16 non-test violations** |
| 9 never edit `routeTree.gen.ts` | `ignores` entry | **Partial.** Lint can stop reporting on it; it cannot stop an edit. Real enforcement is `.gitattributes` `linguist-generated` plus a CODEOWNERS or CI diff check. Out of scope for a linter |
| 9 QueryClient singleton | `@tanstack/query/stable-query-client` | **Enforceable, 0 violations** |
| 10 entity IDs with host prefix | not enforceable | Semantic. No AST shape distinguishes an entity ID from a display name |
| 11 scope discipline | not enforceable | Process |
| 12 commit scope | not enforceable | Process |
| 13 verify review findings | not enforceable | Process |
| 14 comment discipline | **partially**, via inline custom rule | Bare issue/PR refs in comments: **3 violations**, measured. The rest of rule 14 (restating the adjacent line, JSDoc that rephrases the signature, section headers) is a judgment call about meaning and is **not mechanically checkable**. Section headers like `// ===== Setup =====` are the one other detectable shape; currently 0 |
| 15 no claudisms | **partially**, via the same custom rule | **22 em dashes in comments**, measured, all genuine. Banned vocabulary in comments: 0. Do **not** extend this to string and JSX literals: of the 10 non-comment em dashes, 7 are the deliberate `'—'` empty-cell placeholder in `AuthManagementCard.tsx`, so a literal-level rule would be mostly false positives. Commit messages and PR descriptions are outside ESLint's reach entirely and would need a commit-msg hook |
| exact-version pinning | **not an ESLint rule** | See below |

### Two things ESLint structurally cannot do

**Comments are not AST nodes.** `no-restricted-syntax` uses esquery over the AST and cannot see comment text. Rules 14 and 15 therefore need the small inline virtual plugin shown in section 4, which uses `context.sourceCode.getAllComments()`. This was validated in this repo and correctly found the 22 em dashes and 3 issue refs. It is about 20 lines and needs no published package.

**Dependency pinning is not a lint concern.** `agent-updater/package.json` currently violates the rule with four caret ranges: `dockerode: ^5.0.0`, `@types/dockerode: ^4.0.1`, `@types/bun: ^1.3.10`, and `typescript: ^7.0.2`. The last is notable on its own, since the root and `agent/` both pin `typescript: 6.0.3`, so `agent-updater` is floating onto a different TypeScript major. ESLint cannot see this. Enforce it with a few lines of Bun in `scripts/` wired into the existing lint job, or accept it as a review check. Flagging it because it is a live drift, not a hypothetical.

### Gotchas: what lint cannot save you from

Gotchas 5 (React.memo freezing streaming updates) and 12 (virtualizer remount resetting component state) are **not caught by any lint rule in any plugin**. I had the full rule inventories of `eslint-plugin-react-hooks` 7.1.1 (28 rules) and `eslint-plugin-react` 7.37.5 (~105 rules) enumerated and checked. The nearest neighbours are `react-hooks/static-components`, which catches components defined inside render (a different mechanism), and `eslint-plugin-react-perf` / `eslint-plugin-react-usememo`, which target the **inverse** problem of unstable props defeating memo. Both of your gotchas are cross-module runtime reference-identity behaviors; ESLint does single-file AST analysis, and even the React Compiler rules are scoped to one component or hook body. These stay prose rules and review checks. No configuration changes that.

Gotchas 1 (BIGINT string coercion), 3 (stable ordering from Maps), 16 (SSE `Date` fields arriving as strings) are similarly semantic and not expressible.

Gotcha 2 (never add framework packages to `optimizeDeps.include`) is checkable, but as a `no-restricted-syntax` rule against `vite.config.ts`, which is a one-file grep and probably not worth a rule.

---

## 8. CI wiring

Add a **separate `lint` job**. Do not fold it into `build-test`: lint failures should be legible without scrolling past a build log, and the job needs all three packages installed, which `build-test` does not do.

```yaml
  lint:
    name: Lint
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # Type-aware rules need each package's own node_modules for type resolution.
      - name: Install agent dependencies
        run: cd agent && bun install --frozen-lockfile

      - name: Install agent-updater dependencies
        run: cd agent-updater && bun install --frozen-lockfile

      - name: Run ESLint
        run: bun run lint
```

**Gating: yes, from day one.** Buckets 1 and 2 are calibrated to be clean after the adoption PR, so a gating job cannot go red on pre-existing debt. Bucket 3 is `warn`, and warnings do not set a non-zero exit code. Do **not** pass `--max-warnings 0` until bucket 3 has been worked down. That single flag is the promotion lever later.

**Placement.** Insert `lint` as a top-level job immediately after `build-test`, and do **not** add it to any existing `needs:` array. This keeps `sonarcloud`, `publish`, and `deploy-demo` untouched.

**Conflict points with the two in-flight PRs.** `ci.yml` is being edited by a migrations-job PR and an e2e-job PR.

1. *The `jobs:` map.* Three PRs each inserting a new job is a textbook overlapping-insertion conflict if they all target the same line. Mitigation: append `lint` at a distinct anchor (right after the `build-test` block) and expect a trivial resolution.
2. *The `needs:` arrays on `sonarcloud`, `publish`, and `deploy-demo`.* These are currently `[build-test, agent, agent-updater]`. If the migrations or e2e PR adds itself there, and this PR also does, the arrays conflict. **This is the main reason to keep `lint` out of `needs:` initially.** Deciding to gate `publish` on lint is a separate, one-line follow-up made after the other two PRs land.
3. *Bun setup steps.* All three PRs will add `oven-sh/setup-bun@v2` blocks. Textually identical, so usually auto-merges, but worth a look.

**Coexistence with SonarCloud.** These do not meaningfully duplicate. Sonar runs source-to-sink taint analysis (SQL injection, command injection) and tracks coverage and duplication; ESLint here runs type-aware correctness rules and this project's own structural conventions. The overlap that does exist is on generic code smells (unused variables, empty functions), where Sonar's findings arrive as PR annotations and ESLint's as job output. That duplication is mild and self-correcting: fixing one fixes the other. The concrete reason **not** to add `eslint-plugin-security` is that it would duplicate Sonar's strongest area with strictly weaker analysis. No change to `sonar-project.properties` is needed. Note that `sonar.exclusions` already lists `src/routeTree.gen.ts`, matching the ESLint `ignores` entry.

---

## 9. Three packages, one config, no workspace

The brief said two packages; there are in fact three: root, `agent/`, and `agent-updater/`. All three are independent, with separate lockfiles, and `agent/` and `agent-updater/` are each their own Docker build context.

**Recommendation: one config file at the repo root, lint dependencies in the root `package.json` only.**

This works because ESLint's flat config allows per-glob `languageOptions`, so each package's files get their own `tsconfigRootDir` and `projectService` resolves each file against its own nearest `tsconfig.json`. Three blocks, one file, no workspace membership, no duplicated rule list.

Why not a shared base config plus per-package configs: it would require adding `eslint` to `agent/package.json` and `agent-updater/package.json`, which puts a large dev dependency tree into the two lockfiles that the Docker builds consume. The whole reason `agent/` is not a workspace member is to keep `agent/bun.lock` an honest reflection of what ships in the image. Adding ESLint there works against that. Linting is a CI and dev concern; the root is the right home.

The one cost: the `lint` CI job must install all three packages, which the YAML above does. Local `bun run setup` already installs root and agent; the implementing agent should extend it to `agent-updater` if it does not already, or accept that `bun run lint` locally reports type-resolution noise for `agent-updater/src` until that install happens.

---

## 10. What this replaces

The maintainer is dropping a test-based enforcement mechanism for the SSE seam on the understanding that the lint rule replaces it. Here is the exact shape of that trade.

### What the lint rule covers that a test could not

**The `heartbeatMs` hole.** This is the part that makes lint a genuine upgrade rather than a lateral move. A source-scanning test can verify that every route calls `createSseStream`. It cannot see that a route calls it with `heartbeatMs: 0`, which disables the heartbeat entirely while still passing every "uses the seam" assertion. Selector 5 closes that, and it also enforces the upper bound: the Bun default HTTP `idleTimeout` is 10 seconds, so any cadence at or above 10000ms fails to prevent the disconnect the heartbeat exists to prevent. Validated: `0`, `10000`, `60000`, and a non-literal `Number(process.env.HB)` all flagged; `5000` passes.

**Enforcement at the point of writing.** A test tells you after the fact, in CI. The lint rule fires in the editor as the line is typed, with a message naming the fix. For a rule whose entire purpose is "this must not be missed", that is a real difference.

**No test to maintain.** The dropped test had to enumerate route files and would have silently stopped covering any route added outside its glob. The lint config's glob is declarative and applies to files that do not exist yet.

### What is genuinely not covered

**Gap 1: headers forwarded by reference.** A route that does `return new Response(upstream.body, { headers: upstream.headers })` defeats selector 2, because nothing static resolves what those forwarded headers contain. It would also defeat selector 1 if the upstream body is passed through rather than reconstructed. This is a real hole, and the mitigation is partial: forbid a `.body` member expression of a `fetch` result as the first argument to `new Response` within the route globs, which forces pass-throughs through the seam plus `emit.raw`. That is exactly what `docker-logs.$containerId.ts` already does, so the mitigation costs nothing today. I did **not** include it in section 6 because the specification listed it as optional; it is a two-line addition if the maintainer wants the hole closed:

```js
{
  selector: "NewExpression[callee.name='Response'] > MemberExpression.arguments:first-child[property.name='body']",
  message: 'Forward upstream SSE through createSseStream() + emit.raw so the seam still owns headers and heartbeat.',
}
```

I did not empirically validate this selector, unlike the five in section 6. Treat it as needing a fixture before it ships.

**Gap 2: behavioral correctness, uncatchable by any lint rule.** A route can use the seam perfectly, pass all five selectors, and still fail in production if its producer deadlocks before the heartbeat can be enqueued, or if `onStart` blocks the event loop, or if the abort path leaks a subscription. Lint proves the seam is *called*. It cannot prove the stream *behaves*. That is exactly what a behavioral test asserts, and this proposal does not replace it.

**Be explicit about the residual risk:** if the dropped test asserted that a live SSE response actually emits heartbeat frames over time, lint does not cover that and nothing in this document does. The structural guarantee ("every route goes through the seam, with a sane cadence") is strictly stronger than before. The behavioral guarantee ("the seam actually emits") is strictly weaker than before, because it now rests entirely on the seam's own unit tests in `src/lib/sse/__tests__/create-sse-stream.test.ts` rather than on per-route assertions. That is defensible, since the seam is now the single implementation and testing it once is the point of having a seam. But it is a real reduction in coverage at the route level, and calling it a pure win would be dishonest.

**Gap 3: scope.** The rule only fires inside `src/routes/api/**` and `agent/src/routes/**`. SSE construction in a service module, a worker collector, or a new directory is invisible until the glob is widened. The two seam definitions live outside those globs, which is why they need no exemption, but it also means the globs are load-bearing and should be reviewed whenever a new route location appears.

---

## 11. Formatting

**Recommendation: do not add a formatter in this PR.** The repo has none, the maintainer dislikes sprawl, and a formatter's diff blast radius is every file in the repo, which would bury the lint adoption entirely.

For the record, if one is added later: **Biome 2.5.5 in formatter-only mode** (`"linter": { "enabled": false }`) is the best fit, because it is a single self-contained binary with no JS dependency tree, roughly 97% Prettier-compatible, and running Biome-as-formatter alongside ESLint-as-linter is a well-documented 2026 pattern. Its one gap is Tailwind class sorting, which would argue for `eslint-plugin-tailwindcss`'s `classnames-order`.

Do **not** use `@stylistic/eslint-plugin`: those rules are deprecated in ESLint 10 and slated for removal in v11.

One thing I could not confirm: several secondary sources claim `bun fmt` has shipped, but `bun.com` and `bun.sh` returned 403 to every fetch attempt, and the Bun v1.3.14 release notes do not mention it. If `bun fmt` is real and stable, it is obviously the right answer for a Bun-first repo with a no-sprawl preference, and it is worth checking `bun.com/docs` directly before choosing Biome. **I am not asserting either way.**

---

## 12. What this does and does not guarantee

**Guarantees, mechanically, on every PR:**

- No route file in `src/routes/api/**` or `agent/src/routes/**` constructs an SSE response outside `createSseStream`, and none passes an unsafe or non-literal heartbeat cadence.
- No local `.css` file is imported.
- No parent-relative import in non-test `src/`.
- No `console.log` (as a warning; `error`/`info`/`warn` remain allowed).
- No bare `await new Promise(r => setTimeout(...))` in tests.
- No em dash, en dash, banned vocabulary, or bare issue reference in a code comment.
- TanStack Query keys stay exhaustive and the QueryClient stays a singleton.
- The type-aware correctness rules in bucket 1 stay at zero.

**Does not guarantee:**

- That the SSE stream actually emits heartbeats at runtime (section 10, gap 2). This is the real cost of the trade.
- That headers forwarded by reference from an upstream response are caught (gap 1), unless the optional sixth selector is added and validated.
- Anything about `React.memo` freezing streaming updates (gotcha 5) or virtualizer remounts resetting state (gotcha 12). No lint rule in any plugin catches either, confirmed against full rule inventories.
- That `routeTree.gen.ts` is not edited. Lint ignores it; it does not protect it.
- That dependencies stay pinned. Not an ESLint concern; `agent-updater/package.json` already violates it four times.
- Comment *quality* under rule 14. Only the mechanically detectable shapes are covered; "restates the adjacent line" is not one of them.
- Anything about commit messages or PR descriptions under rule 15.

**Honest summary of cost:** one `--fix` commit of about 420 mechanical changes, two one-line fixes (`settings.ts` serializer, `login.tsx` property order), one deleted stale disable comment, four test cleanups for rule 7, and roughly 16 `console.log` calls to reclassify. Everything else starts as a warning and can be worked down at leisure. CI time increases by about 45 to 60 seconds for the type-aware pass.

---

## Appendix: measurement method

- ESLint 10.8.0, typescript-eslint 8.65.0, `@eslint/js` 10.0.1, `eslint-plugin-react-hooks` 7.1.1, `@tanstack/eslint-plugin-query` 5.101.4, `@tanstack/eslint-plugin-router` 1.162.0, installed in a scratch directory outside the repo. No repo file was modified and no dependency was added to any `package.json`.
- Repo dependencies installed with `bun install --frozen-lockfile --force` so type-aware rules could resolve types.
- Counts come from `eslint -f json` output tallied by rule ID, with test and non-test split on `__tests__/` and `src/lib/test/`, and with true autofixes (`message.fix`) separated from suggestions (`message.suggestions`), which are not applied by `--fix`.
- Timings on this machine: 42.2s type-aware over 590 files in `src/`; 6.4s over 30 files in `agent/src`; 0.85s for the SSE seam rules alone; 14.8s for `tsc --noEmit` as a reference point.
- The SSE seam rule was validated against a purpose-built fixture covering all five forbidden shapes and six legitimate counter-cases, then against the real tree.
