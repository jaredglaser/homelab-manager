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

// Agent TLS seam: a raw fetch or WebSocket built from an agent-URL variable fails the per-host
// certificate check and the caller retries it as a fake agent outage. Matched argument shapes:
// identifiers named agent/agentBase/agentBaseUrl/agentUrl and their .agentUrl-style and computed
// members. A URL held under another name, or reached through an alias of fetch, still escapes.
const AGENT_TLS_URL_NAME = "/^agent(?:Base)?(?:Url)?$/i";
const AGENT_TLS_CALLEES = {
  fetch: [
    `CallExpression[callee.name='fetch']`,
    `CallExpression[callee.object.name=/^(globalThis|window|self)$/][callee.property.name='fetch']`,
  ],
  websocket: [
    `NewExpression[callee.name='WebSocket']`,
    `NewExpression[callee.object.name=/^(globalThis|window|self)$/][callee.property.name='WebSocket']`,
  ],
};
const AGENT_TLS_URL_ARGS = [
  `Identifier[name=${AGENT_TLS_URL_NAME}]`,
  `MemberExpression[property.name=${AGENT_TLS_URL_NAME}]`,
  `MemberExpression[computed=true][property.value=${AGENT_TLS_URL_NAME}]`,
];
function agentTlsSelector(callees) {
  return callees.flatMap((callee) => AGENT_TLS_URL_ARGS.map((arg) => `${callee} ${arg}`)).join(', ');
}
const AGENT_TLS_FETCH = {
  selector: agentTlsSelector(AGENT_TLS_CALLEES.fetch),
  message:
    'Raw fetch() to an agent URL bypasses the pinned per-host TLS certificate and fails with "self signed certificate" on https agents while the caller retries forever. Use agentFetch from src/lib/clients/agent-http.ts with the host caCertPem (null for http URLs).',
};
const AGENT_TLS_WEBSOCKET = {
  selector: agentTlsSelector(AGENT_TLS_CALLEES.websocket),
  message:
    'Raw WebSocket() to an agent URL bypasses the pinned per-host TLS certificate and fails the TLS handshake on wss agents. Use openAgentWebSocket from src/lib/clients/agent-http.ts with the host caCertPem (null for ws URLs).',
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

const flattenUnion = (node) =>
  node.types.flatMap((member) => (member.type === 'TSUnionType' ? flattenUnion(member) : [member]));

const isStringNumberUnion = (members) => {
  const kinds = members.map((member) => member.type);
  return kinds.includes('TSStringKeyword') && kinds.includes('TSNumberKeyword');
};

const isDateStringUnion = (members) =>
  members.some((member) => member.type === 'TSTypeReference' && member.typeName?.name === 'Date') &&
  members.some((member) => member.type === 'TSStringKeyword');

const noOverwideUnionRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Resolve a wire type to the one it actually carries. A string-or-number union hides which one, and the coercion it invites masks a wrong value as NaN.',
    },
    schema: [],
    messages: {
      overwide:
        'This unions a string with a number, or a Date with a string, so nothing downstream knows which one arrives. Pick the type the value actually carries, or disable this rule on the line with the reason it can genuinely be either.',
    },
  },
  create(context) {
    return {
      TSUnionType(node) {
        if (node.parent.type === 'TSUnionType') return;
        const members = flattenUnion(node);
        if (isStringNumberUnion(members) || isDateStringUnion(members)) {
          context.report({ node, messageId: 'overwide' });
        }
      },
    };
  },
};

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

function objectLiteralKey(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') return String(property.key.value);
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (current.type === 'TSSatisfiesExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSNonNullExpression')
  ) {
    current = current.expression;
  }
  return current;
}

const agentErrorCodeRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Response.json error bodies in agent route modules must carry a code from AGENT_ROUTE_FAILURE_CODES beside the human message.',
    },
    schema: [],
    messages: {
      missingCode:
        'This error body sends prose only. Wrap it in routeErrorBody(code, message) from agent/src/lib/error-body.ts, with a code from AGENT_ROUTE_FAILURE_CODES in agent/src/types.ts, so a caller branches on the reason instead of matching the message.',
    },
  },
  create(context) {
    return {
      "CallExpression[callee.object.name='Response'][callee.property.name='json']"(node) {
        const body = unwrapExpression(node.arguments[0]);
        if (!body || body.type !== 'ObjectExpression') return;
        const keys = body.properties.map(objectLiteralKey);
        if (!keys.includes('error') || keys.includes('code')) return;
        context.report({ node: body, messageId: 'missingCode' });
      },
    };
  },
};

// Manager files that read agent response bodies. The agent's wire schemas live in
// agent/src/types.ts (HTTP) and agent/src/types/protocol.ts (SSE), so a reader here parses with
// those instead of describing the body again (AGENTS.md rule 18).
const AGENT_WIRE_READERS = [
  'src/lib/clients/**/*.ts',
  'src/lib/services/agent-*.ts',
  'src/data/hosts/handlers.ts',
  'src/worker/collectors/**/*.ts',
];

const noLocalAgentSchemaRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Agent body schemas are declared once in the agent contract, not in the manager code that reads them.' },
    schema: [],
    messages: {
      localSchema:
        'This declares an object schema in a file that reads agent bodies. Declare the body in agent/src/types.ts (HTTP) or agent/src/types/protocol.ts (SSE), infer its type there, and parse with that schema (AGENTS.md rule 18).',
    },
  },
  create(context) {
    return {
      "CallExpression[callee.object.name='z'][callee.property.name=/^(?:object|strictObject|looseObject)$/]"(node) {
        context.report({ node, messageId: 'localSchema' });
      },
    };
  },
};

const noAgentBodyCastRule = {
  meta: {
    type: 'problem',
    docs: { description: 'A parsed agent body is checked against the shared schema, not cast to a type.' },
    schema: [],
    messages: {
      cast:
        'This casts parsed JSON instead of checking it. Parse it with the agent contract schema from agent/src/types.ts or agent/src/types/protocol.ts (AGENTS.md rule 18).',
    },
  },
  create(context) {
    return {
      "TSAsExpression > CallExpression[callee.object.name='JSON'][callee.property.name='parse']"(node) {
        context.report({ node: node.parent, messageId: 'cast' });
      },
    };
  },
};

const MESSAGE_MATCH_METHODS = ['includes', 'startsWith', 'endsWith', 'match', 'search', 'indexOf', 'test'];

const isMessageMember = (node) =>
  node?.type === 'MemberExpression' &&
  ((node.property.type === 'Identifier' && node.property.name === 'message') ||
    (node.computed && node.property.type === 'Literal' && node.property.value === 'message'));

const MESSAGE_NORMALIZERS = ['toLowerCase', 'toUpperCase', 'trim'];

const isMessageLike = (node) =>
  isMessageMember(node) ||
  (node?.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.property?.type === 'Identifier' &&
    MESSAGE_NORMALIZERS.includes(node.callee.property.name) &&
    isMessageMember(node.callee.object));

const noErrorMessageMatchingRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Classify a failure by a code or a typed field, never by matching error.message text.',
    },
    schema: [],
    messages: {
      messageMatch:
        'This classifies a failure by matching its message text, so a reword silently changes what the code does. Branch on a code or a typed field instead. Transport-level noise (socket teardown, connection loss) is the only exception: disable this rule on the line with the reason it is transport, not classification.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const { property } = callee;
        if (property.type !== 'Identifier' || !MESSAGE_MATCH_METHODS.includes(property.name)) return;
        if (isMessageLike(callee.object) || node.arguments.some(isMessageLike)) {
          context.report({ node, messageId: 'messageMatch' });
        }
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
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'server/**/*.ts', 'e2e/**/*.ts', 'vite.config.ts', 'playwright.config.ts', 'playwright.auth.config.ts'],
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
      'src/lib/clients/agent-http.ts',
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
        AGENT_TLS_FETCH,
        AGENT_TLS_WEBSOCKET,
      ],
    },
  },
  // The mux seam owns frame construction and its timing internals, and the mock
  // and test doubles emulate it, so only the socket and tripwire rules bind here.
  {
    files: ['src/lib/mux/**/*.ts', 'src/lib/mock/**/*.ts', 'src/lib/test/**/*.ts'],
    ignores: ['**/__tests__/**', 'src/lib/mux/mux-connection.ts'],
    rules: {
      'no-restricted-syntax': ['error', WS_MUX_SOCKET, WS_MUX_SSE_TRIPWIRE, AGENT_TLS_FETCH, AGENT_TLS_WEBSOCKET],
    },
  },
  // mux-connection.ts is the sanctioned client WebSocket site and imports its
  // timing from keepalive.ts, so only the timing and tripwire rules bind here.
  {
    files: ['src/lib/mux/mux-connection.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        WS_MUX_TIMING_LITERAL,
        WS_MUX_TIMING_CONST,
        WS_MUX_SSE_TRIPWIRE,
        AGENT_TLS_FETCH,
        AGENT_TLS_WEBSOCKET,
      ],
    },
  },
  // agent-http.ts is the sanctioned server-to-agent socket seam: openAgentWebSocket
  // wraps Bun's WebSocket with the pinned per-host TLS certificate, so the socket
  // rule is lifted here while the rest still bind.
  {
    files: ['src/lib/clients/agent-http.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        WS_MUX_FRAME,
        WS_MUX_TIMING_LITERAL,
        WS_MUX_TIMING_CONST,
        WS_MUX_SSE_TRIPWIRE,
        AGENT_TLS_FETCH,
        AGENT_TLS_WEBSOCKET,
      ],
    },
  },
  // The exec terminal keeps a direct socket end to end (hook plus server bridge).
  {
    files: ['src/hooks/useContainerTerminal.ts', 'server/routes/api/docker-exec/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        WS_MUX_FRAME,
        WS_MUX_TIMING_LITERAL,
        WS_MUX_TIMING_CONST,
        WS_MUX_SSE_TRIPWIRE,
        AGENT_TLS_FETCH,
        AGENT_TLS_WEBSOCKET,
      ],
    },
  },
  // The server endpoint originates ack and event frames and imports its timing
  // from keepalive.ts, so only the socket, timing, and tripwire rules bind here.
  {
    files: ['server/routes/api/mux.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        WS_MUX_SOCKET,
        WS_MUX_TIMING_LITERAL,
        WS_MUX_TIMING_CONST,
        WS_MUX_SSE_TRIPWIRE,
        AGENT_TLS_FETCH,
        AGENT_TLS_WEBSOCKET,
      ],
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

  // ESLint 10 rejects redefining a plugin name for the same file, so every
  // local/ rule is registered in this one block; the rule blocks below only bind them.
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'agent/src/**/*.ts'],
    plugins: {
      local: {
        rules: {
          'endpoint-auth': endpointAuthRule,
          'no-error-message-matching': noErrorMessageMatchingRule,
          'agent-error-code': agentErrorCodeRule,
          'no-overwide-union': noOverwideUnionRule,
          'no-local-agent-schema': noLocalAgentSchemaRule,
          'no-agent-body-cast': noAgentBodyCastRule,
        },
      },
    },
  },

  // Endpoint auth enforcement. Route files branch to route mode inside the rule via the filename check and everything else here is createServerFn mode.
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'local/endpoint-auth': 'error' },
  },

  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'agent/src/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'local/no-overwide-union': 'error' },
  },

  // Scope: components/**, scripts/** and vite.config.ts stay out until their matches have a code to branch on.
  {
    files: ['src/lib/**/*.{ts,tsx}', 'agent/src/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'local/no-error-message-matching': 'error' },
  },

  // no-local-agent-schema: 0 findings, so error per the calibration rule. no-agent-body-cast: 3
  // findings (agent-client.ts success path, agent-provisioning-service.ts, agent-health-service.ts),
  // so warn until they parse with the contract schemas.
  {
    files: AGENT_WIRE_READERS,
    ignores: ['**/__tests__/**'],
    rules: { 'local/no-local-agent-schema': 'error', 'local/no-agent-body-cast': 'warn' },
  },

  // A stale eslint-disable is enforcement that reads as done, so it fails the build instead of warning.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  // AGENTS.md rule 8.
  {
    files: ['src/**/*.{ts,tsx}', 'agent/src/**/*.ts'],
    rules: { 'no-console': ['warn', { allow: ['error', 'info', 'warn'] }] },
  },

  // Everything below has existing violations, so it lands as warn to keep this PR at zero errors.
  // These still carry findings, so they stay warn until worked down.
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

  // Add a tree here only after its findings reach zero, and confirm with eslint --print-config.
  {
    files: [
      'src/components/**/*.{ts,tsx}',
      'src/data/**/*.{ts,tsx}',
      'src/routes/**/*.{ts,tsx}',
      'server/**/*.ts',
    ],
    ignores: ['**/__tests__/**'],
    rules: { 'no-console': ['error', { allow: ['error', 'info', 'warn'] }] },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**'],
    rules: { 'prefer-const': 'error', 'no-empty': 'error' },
  },
  {
    files: ['src/data/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}', 'server/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: [
      'src/lib/**/*.{ts,tsx}',
      'src/data/**/*.{ts,tsx}',
      'agent/src/**/*.ts',
      'server/**/*.ts',
      'scripts/**/*.ts',
    ],
    ignores: ['**/__tests__/**'],
    rules: { '@typescript-eslint/no-import-type-side-effects': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'agent/src/**/*.ts'],
    ignores: ['**/__tests__/**', 'src/worker/**'],
    rules: { '@typescript-eslint/no-duplicate-type-constituents': 'error' },
  },

  // Binds local/agent-error-code for agent route modules; the rule itself is
  // registered once in the shared local plugin block above.
  {
    files: ['agent/src/routes/**/*.ts'],
    rules: { 'local/agent-error-code': 'error' },
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
