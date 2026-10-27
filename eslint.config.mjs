import js from '@eslint/js';
import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginRouter from '@tanstack/eslint-plugin-router';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// WS mux seam: one browser WebSocket, frames built at the mux seam, keepalive
// timing from one constants module, and a tripwire against the deleted SSE surface.
const WS_MUX_SOCKET = {
  selector: "NewExpression[callee.name='WebSocket']",
  message:
    'Do not open a raw WebSocket outside the mux seam. Use MuxConnection from src/lib/mux/mux-connection.ts for live topics. The exec terminal keeps its direct socket in src/hooks/useContainerTerminal.ts with its server bridge in server/routes/api/docker-exec.',
};

const WS_MUX_FRAME = {
  selector:
    ":matches(Property[key.name='type'], Property[key.value='type']) > Literal[value=/^(?:sub|unsub|ack|event|ping)$/]",
  message:
    'Hand-rolled mux frame. Build wire frames at the mux seam (src/lib/mux/* via src/lib/mux/protocol.ts, or the server endpoint server/routes/api/mux.ts) so the frame grammar stays in one place.',
};

const WS_MUX_TIMING_LITERAL = {
  selector:
    "Property[key.name=/(?:^|[^a-zA-Z])(?:ping|PING)|Ping/][value.type='Literal'][value.raw=/^[0-9]/], Property[key.name=/heartbeat|keepalive|backoff|retr(?:y|ies)|reconnect/i][value.type='Literal'][value.raw=/^[0-9]/], Property[key.value=/(?:^|[^a-zA-Z])(?:ping|PING)|Ping/][value.type='Literal'][value.raw=/^[0-9]/], Property[key.value=/heartbeat|keepalive|backoff|retr(?:y|ies)|reconnect/i][value.type='Literal'][value.raw=/^[0-9]/]",
  message:
    'Mux keepalive and reconnect timing must reference src/lib/mux/keepalive.ts (PING_INTERVAL_MS, RECONNECT_BASE_BACKOFF_MS, RECONNECT_MAX_BACKOFF_MS). A numeric literal here drifts from the shared cadence.',
};

const WS_MUX_TIMING_CONST = {
  selector:
    "VariableDeclarator[id.name=/(?:^|[^a-zA-Z])(?:ping|PING)|Ping/][init.type='Literal'][init.raw=/^[0-9]/], VariableDeclarator[id.name=/heartbeat|keepalive|reconnect/i][init.type='Literal'][init.raw=/^[0-9]/]",
  message:
    'Mux keepalive and reconnect constants live in src/lib/mux/keepalive.ts (PING_INTERVAL_MS, RECONNECT_BASE_BACKOFF_MS, RECONNECT_MAX_BACKOFF_MS). Reference them instead of re-hardcoding the cadence.',
};

const WS_MUX_SSE_TRIPWIRE = {
  selector: "Identifier[name='createSseStream']",
  message:
    'createSseStream is the deleted web SSE seam. Stream over the WS mux (src/lib/mux). The only sanctioned createSseStream is the agent-side seam agent/src/lib/sse-stream.ts for web-to-agent hops.',
};

export const WS_MUX_SEAM_RESTRICTIONS = [
  WS_MUX_SOCKET,
  WS_MUX_FRAME,
  WS_MUX_TIMING_LITERAL,
  WS_MUX_TIMING_CONST,
  WS_MUX_SSE_TRIPWIRE,
];

// Endpoint auth enforcement. Exemptions are inline eslint-disable directives at the exempt site, never a central allowlist.
// resolveUserFromCookie only counts as a call argument, never a callee: it resolves a user without rejecting, so a route that calls it and ignores the result stays unauthenticated.
const ENFORCING_SEAM_NAMES = ['authMiddleware', 'requireRole', 'authenticateWsUpgrade', 'authenticateRequest'];
const ARGUMENT_SEAM_NAMES = [...ENFORCING_SEAM_NAMES, 'resolveUserFromCookie'];

const endpointAuthRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Route modules and createServerFn chains must enforce auth or carry an inline eslint-disable with the reason they are unauthenticated by design.',
    },
    schema: [],
    messages: {
      routeMissingAuth:
        'Route references no auth enforcement call (authenticateWsUpgrade, authenticateRequest, authMiddleware, requireRole as a call callee or argument). resolveUserFromCookie does not qualify because it resolves a user without rejecting. Add auth enforcement or disable this rule at the top of the file with the reason it is unauthenticated by design.',
      fnMissingAuth:
        'createServerFn chain attaches no authMiddleware. Add it to .middleware([...]) or disable this rule on this line with the reason the function is unauthenticated by design.',
    },
  },
  create(context) {
    const filename = context.filename;
    if (filename.includes('/server/routes/') || filename.includes('/src/routes/api/')) {
      let sawEnforcingCall = false;
      return {
        'CallExpression > Identifier'(node) {
          const call = node.parent;
          if (call.callee === node) {
            if (ENFORCING_SEAM_NAMES.includes(node.name)) sawEnforcingCall = true;
          } else if (call.arguments.includes(node)) {
            if (ARGUMENT_SEAM_NAMES.includes(node.name)) sawEnforcingCall = true;
          }
        },
        'Program:exit'(program) {
          if (!sawEnforcingCall) context.report({ node: program, messageId: 'routeMissingAuth' });
        },
      };
    }
    return {
      'CallExpression[callee.name="createServerFn"]'(node) {
        let cursor = node;
        let hasAuthMiddleware = false;
        while (cursor.parent) {
          if (cursor.parent.type !== 'MemberExpression' || cursor.parent.object !== cursor) break;
          const member = cursor.parent;
          if (member.parent.type !== 'CallExpression' || member.parent.callee !== member) break;
          const call = member.parent;
          if (member.property.type === 'Identifier' && member.property.name === 'middleware') {
            const list = call.arguments[0];
            if (
              list &&
              list.type === 'ArrayExpression' &&
              list.elements.some((el) => el && el.type === 'Identifier' && el.name === 'authMiddleware')
            ) {
              hasAuthMiddleware = true;
            }
          }
          cursor = call;
        }
        if (!hasAuthMiddleware) context.report({ node, messageId: 'fnMissingAuth' });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.output/**',
      '.nitro/**',
      '.tanstack/**',
      'e2e-build/**',
      '**/dist/**',
      'coverage/**',
      'public/**',
      'src/routeTree.gen.ts',
      '.codex/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'server/**/*.ts', 'e2e/**/*.ts', 'vite.config.ts', 'playwright.config.ts'],
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
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  ...pluginQuery.configs['flat/recommended'],
  ...pluginRouter.configs['flat/recommended'],

  // 68 existing violations, so warn. These are real bugs rather than style, but each needs a
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
                'TailwindCSS only. The single allowed stylesheet is src/App.css (AGENTS.md rule 1).',
            },
          ],
        },
      ],
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
              message: 'Use the @/ alias for src imports outside __tests__ (AGENTS.md rule 2).',
            },
          ],
        },
      ],
    },
  },

  // WS mux seam at call sites: everything outside the seam files below goes
  // through the mux instead of owning a socket, frames, or keepalive timing.
  {
    files: [
      'src/**/*.{ts,tsx}',
      'server/**/*.ts',
      'scripts/**/*.ts',
      'e2e/**/*.ts',
      'vite.config.ts',
      'playwright.config.ts',
    ],
    ignores: [
      '**/__tests__/**',
      'src/lib/mux/**',
      'src/lib/mock/**',
      'src/lib/test/**',
      'src/hooks/useContainerTerminal.ts',
      'server/routes/api/docker-exec/**',
      'server/routes/api/mux.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        WS_MUX_SOCKET,
        WS_MUX_FRAME,
        WS_MUX_TIMING_LITERAL,
        WS_MUX_TIMING_CONST,
        WS_MUX_SSE_TRIPWIRE,
      ],
    },
  },
  // The mux seam owns frame construction and its timing internals, and the mock
  // and test doubles emulate it, so only the socket and tripwire rules bind here.
  {
    files: ['src/lib/mux/**/*.ts', 'src/lib/mock/**/*.ts', 'src/lib/test/**/*.ts'],
    ignores: ['**/__tests__/**', 'src/lib/mux/mux-connection.ts'],
    rules: {
      'no-restricted-syntax': ['error', WS_MUX_SOCKET, WS_MUX_SSE_TRIPWIRE],
    },
  },
  // mux-connection.ts is the sanctioned client WebSocket site and imports its
  // timing from keepalive.ts, so only the timing and tripwire rules bind here.
  {
    files: ['src/lib/mux/mux-connection.ts'],
    rules: {
      'no-restricted-syntax': ['error', WS_MUX_TIMING_LITERAL, WS_MUX_TIMING_CONST, WS_MUX_SSE_TRIPWIRE],
    },
  },
  // The exec terminal keeps a direct socket end to end (hook plus server bridge).
  {
    files: ['src/hooks/useContainerTerminal.ts', 'server/routes/api/docker-exec/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-syntax': ['error', WS_MUX_FRAME, WS_MUX_TIMING_LITERAL, WS_MUX_TIMING_CONST, WS_MUX_SSE_TRIPWIRE],
    },
  },
  // The server endpoint originates ack and event frames and imports its timing
  // from keepalive.ts, so only the socket, timing, and tripwire rules bind here.
  {
    files: ['server/routes/api/mux.ts'],
    rules: {
      'no-restricted-syntax': ['error', WS_MUX_SOCKET, WS_MUX_TIMING_LITERAL, WS_MUX_TIMING_CONST, WS_MUX_SSE_TRIPWIRE],
    },
  },

  // 0 findings since the rule 7 cleanup, so it lands as error per the calibration rule.
  {
    files: ['**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AwaitExpression > NewExpression[callee.name='Promise'] > :function CallExpression[callee.name='setTimeout']",
          message:
            'Do not await a bare setTimeout to let async settle (AGENTS.md rule 7). Await a deterministic signal, use waitFor/findBy*, or spy on globalThis.setTimeout.',
        },
      ],
    },
  },
  { files: ['src/lib/test/wait-for-condition.ts'], rules: { 'no-restricted-syntax': 'off' } },

  // Endpoint auth enforcement. Route files branch to route mode inside the rule via the filename check and everything else here is createServerFn mode.
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
    ignores: ['**/__tests__/**'],
    plugins: { local: { rules: { 'endpoint-auth': endpointAuthRule } } },
    rules: { 'local/endpoint-auth': 'error' },
  },

  // AGENTS.md rule 8. 45 findings; promoted to error by the console cleanup PR (3 of 3).
  {
    files: ['src/**/*.{ts,tsx}', 'agent/src/**/*.ts'],
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
