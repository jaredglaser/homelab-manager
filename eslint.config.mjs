import js from '@eslint/js';
import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginRouter from '@tanstack/eslint-plugin-router';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const BANNED_COMMENT_PROSE = [
  [/[—–]/, 'an em dash or en dash'],
  [
    /\b(delve|tapestry|intricate|robust|comprehensive|meticulous|leverage|utilize|facilitate)\b/i,
    'banned vocabulary',
  ],
  [/\bit's (worth|important to) not(e|ing)\b/i, 'a banned filler phrase'],
  [/\b(essentially|fundamentally|carefully|thoroughly|comprehensively)\b/i, 'a performative qualifier'],
  [/(?:^|\s)#\d{2,5}\b/, 'a bare issue or PR reference, which belongs in the commit message'],
];

const localPlugin = {
  rules: {
    'no-claudisms-in-comments': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              for (const [pattern, label] of BANNED_COMMENT_PROSE) {
                if (pattern.test(comment.value)) {
                  context.report({
                    loc: comment.loc,
                    message: `Comment contains ${label}. See CLAUDE.md rules 14 and 15.`,
                  });
                  break;
                }
              }
            }
          },
        };
      },
    },
  },
};

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

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.output/**',
      '**/dist/**',
      'coverage/**',
      'public/**',
      'src/routeTree.gen.ts',
      '.claude/**',
      '.codex/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  { plugins: { local: localPlugin } },

  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'server/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['agent/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/agent` },
      globals: { ...globals.node },
    },
  },
  {
    files: ['agent-updater/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/agent-updater` },
      globals: { ...globals.node },
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  ...pluginQuery.configs['flat/recommended'],
  ...pluginRouter.configs['flat/recommended'],

  // 64 existing violations, so warn. These are real bugs rather than style, but each needs a
  // judgement call about the component; no follow-up PR is scheduled to clear them yet.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/routes/**/*.tsx'],
    rules: { '@tanstack/router/create-route-property-order': 'warn' },
  },

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*.css', '../*.css', '@/**/*.css', '!**/App.css'],
              message:
                'TailwindCSS only. The single allowed stylesheet is src/App.css (CLAUDE.md rule 1).',
            },
          ],
        },
      ],

      'local/no-claudisms-in-comments': 'warn',
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**', 'src/lib/test/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['../*'],
              message: 'Use the @/ alias for src imports outside __tests__ (CLAUDE.md rule 2).',
            },
          ],
        },
      ],
    },
  },

  // 24 findings: 22 in the four agent routes that still hand-roll `new ReadableStream`, plus the
  // inlined serialize frame in api/settings.ts and api/docker-inventory.ts. Promote to error once
  // claude/agent-sse-heartbeats lands and those routes go through createSseStream.
  {
    files: ['src/routes/api/**/*.ts', 'agent/src/routes/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'no-restricted-syntax': ['warn', ...SSE_SEAM_RESTRICTIONS] },
  },

  // 106 findings, 102 of them in agent/src tests.
  {
    files: ['**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "AwaitExpression > NewExpression[callee.name='Promise'] > :function CallExpression[callee.name='setTimeout']",
          message:
            'Do not await a bare setTimeout to let async settle (CLAUDE.md rule 7). Await a deterministic signal, use waitFor/findBy*, or spy on globalThis.setTimeout.',
        },
      ],
    },
  },
  { files: ['src/lib/test/wait-for-condition.ts'], rules: { 'no-restricted-syntax': 'off' } },

  // CLAUDE.md rule 8. 45 findings; promoted to error by the console cleanup PR (3 of 3).
  {
    files: ['src/**/*.{ts,tsx}', 'agent/src/**/*.ts', 'agent-updater/src/**/*.ts'],
    rules: { 'no-console': ['warn', { allow: ['error', 'info', 'warn'] }] },
  },

  // Everything below has existing violations, so it lands as warn to keep this PR at zero errors.
  // The first group is autofixable and gets promoted to error by the autofix sweep PR (2 of 3);
  // the rest need per-site judgement and stay warnings until worked down.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'prefer-const': 'warn',
      '@typescript-eslint/no-import-type-side-effects': 'warn',
      '@typescript-eslint/no-duplicate-type-constituents': 'warn',
      '@typescript-eslint/return-await': ['warn', 'always'],
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'require-yield': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

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
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },

  // Must stay last so it wins over the rule blocks above. No tsconfig reaches these files:
  // the root tsconfig's `**/*.ts` skips dot-directories and .js is outside `include`, so a
  // type-aware rule here is a hard crash rather than a finding.
  {
    files: ['**/*.{js,mjs,cjs}', '.github/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
);
