// Exemptions are inline eslint-disable directives at the exempt site, never a central allowlist.
// resolveUserFromCookie only counts as a call argument, never a callee: it resolves a user without rejecting, so a route that calls it and ignores the result stays unauthenticated.
const ENFORCING_SEAM_NAMES = ['authMiddleware', 'requireRole', 'authenticateWsUpgrade', 'authenticateRequest'];
const ARGUMENT_SEAM_NAMES = [...ENFORCING_SEAM_NAMES, 'resolveUserFromCookie'];

const isAuthMiddleware = (el) => el?.type === 'Identifier' && el.name === 'authMiddleware';
const isRoleMiddleware = (el) =>
  el?.type === 'CallExpression' && el.callee.type === 'Identifier' && el.callee.name === 'roleMiddleware';

function chainMiddleware(createServerFnCall) {
  const elements = [];
  let cursor = createServerFnCall;
  while (cursor.parent) {
    if (cursor.parent.type !== 'MemberExpression' || cursor.parent.object !== cursor) break;
    const member = cursor.parent;
    if (member.parent.type !== 'CallExpression' || member.parent.callee !== member) break;
    const call = member.parent;
    const list = call.arguments[0];
    if (member.property.type === 'Identifier' && member.property.name === 'middleware' && list?.type === 'ArrayExpression') {
      elements.push(...list.elements);
    }
    cursor = call;
  }
  return elements;
}

export const endpointAuthRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Route modules must enforce auth, and createServerFn chains must open with authMiddleware directly followed by one roleMiddleware(...), or carry an inline eslint-disable with the reason they are unauthenticated by design.',
    },
    schema: [],
    messages: {
      routeMissingAuth:
        'Route references no auth enforcement call (authenticateWsUpgrade, authenticateRequest, authMiddleware, requireRole as a call callee or argument). resolveUserFromCookie does not qualify because it resolves a user without rejecting. Add auth enforcement or disable this rule at the top of the file with the reason it is unauthenticated by design.',
      fnMissingAuth:
        'createServerFn chain attaches no authMiddleware. Add it to .middleware([...]) or disable this rule on this line with the reason the function is unauthenticated by design.',
      fnMissingRole:
        "createServerFn chain declares no roles. Add roleMiddleware(...) directly after authMiddleware in .middleware([...]), naming every role that may call it (a read open to every signed-in user is roleMiddleware('admin', 'operator', 'viewer')).",
      fnAuthNotFirst:
        'authMiddleware must be the first middleware in the chain. Anything before it (a database pool, decrypted stack secrets) runs for a caller who is not signed in or whose role is then refused.',
      fnRoleNotAfterAuth:
        'roleMiddleware(...) must come directly after authMiddleware. Before it, the user is not resolved yet. After another middleware, that middleware (a database pool, decrypted stack secrets) runs for a caller the role check then refuses.',
      fnDuplicateRole:
        'A second roleMiddleware(...) in one chain. Both must pass, so the function allows only the roles the calls share, which no reader of either call sees. Name every allowed role in one call.',
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
        const elements = chainMiddleware(node);
        const authIndex = elements.findIndex(isAuthMiddleware);
        const roleCalls = elements.filter(isRoleMiddleware);
        if (authIndex === -1) {
          context.report({ node, messageId: 'fnMissingAuth' });
          return;
        }
        if (authIndex > 0) context.report({ node: elements[authIndex], messageId: 'fnAuthNotFirst' });
        if (roleCalls.length === 0) {
          context.report({ node, messageId: 'fnMissingRole' });
        } else if (elements[authIndex + 1] !== roleCalls[0]) {
          context.report({ node: roleCalls[0], messageId: 'fnRoleNotAfterAuth' });
        }
        for (const duplicate of roleCalls.slice(1)) {
          context.report({ node: duplicate, messageId: 'fnDuplicateRole' });
        }
      },
    };
  },
};
