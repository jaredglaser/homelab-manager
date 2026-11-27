import { describe, it, expect } from 'bun:test';
import ts from 'typescript';
import type { Role } from '@/lib/auth/types';

const SIGNED_OUT = 'signed out';

const EXPECTED: Record<string, readonly Role[] | typeof SIGNED_OUT> = {
  'src/data/auth.functions.tsx:getRoleMapping': ['admin'],
  'src/data/auth.functions.tsx:getSession': SIGNED_OUT,
  'src/data/auth.functions.tsx:listSessions': ['admin'],
  'src/data/auth.functions.tsx:listUsers': ['admin'],
  'src/data/auth.functions.tsx:revokeAllUserSessions': ['admin'],
  'src/data/auth.functions.tsx:revokeSession': ['admin'],
  'src/data/docker/functions.tsx:clearContainerIcon': ['admin', 'operator'],
  'src/data/docker/functions.tsx:controlContainer': ['admin', 'operator'],
  'src/data/docker/functions.tsx:getContainerHistory': ['admin', 'operator', 'viewer'],
  'src/data/docker/functions.tsx:getDockerEntityIcons': ['admin', 'operator', 'viewer'],
  'src/data/docker/functions.tsx:getHistoricalDockerStats': ['admin', 'operator', 'viewer'],
  'src/data/docker/functions.tsx:updateContainerIcon': ['admin', 'operator'],
  'src/data/git-tokens.functions.tsx:createGitToken': ['admin', 'operator'],
  'src/data/git-tokens.functions.tsx:listGitTokens': ['admin', 'operator'],
  'src/data/git-tokens.functions.tsx:revokeGitToken': ['admin', 'operator'],
  'src/data/hosts/functions.tsx:checkHostHealth': ['admin', 'operator'],
  'src/data/hosts/functions.tsx:createPendingHost': ['admin'],
  'src/data/hosts/functions.tsx:getHostPublicJwk': ['admin'],
  'src/data/hosts/functions.tsx:listAgentsInventory': ['admin', 'operator', 'viewer'],
  'src/data/hosts/functions.tsx:listHosts': ['admin', 'operator', 'viewer'],
  'src/data/hosts/functions.tsx:removeHost': ['admin'],
  'src/data/hosts/functions.tsx:rotateHostKeypair': ['admin'],
  'src/data/hosts/functions.tsx:rotateHostTls': ['admin'],
  'src/data/hosts/functions.tsx:updateAgent': ['admin'],
  'src/data/hosts/functions.tsx:updateHost': ['admin'],
  'src/data/proxmox/functions.tsx:getHistoricalProxmoxStats': ['admin', 'operator', 'viewer'],
  'src/data/settings/functions.tsx:updateSetting': ['admin', 'operator'],
  'src/data/settings/functions.tsx:updateUserSetting': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:checkImageUpdates': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:controlStack': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:createStack': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:deleteStack': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:deleteVariable': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:ensureVariablesExist': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:getDeployHistory': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:getImageChangelog': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:getImageUpdateInfo': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:getStackDetail': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:getStackVariableValues': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:listManagedHostNames': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:listStacks': ['admin', 'operator', 'viewer'],
  'src/data/stacks/functions.tsx:rejectDeploy': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:resolveDrift': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:resumeDeploy': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:saveComposeFile': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:scanDrift': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:setVariableValue': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:triggerDeploy': ['admin', 'operator'],
  'src/data/stacks/functions.tsx:updateStackSettings': ['admin', 'operator'],
  'src/data/zfs/functions.tsx:getHistoricalZFSStats': ['admin', 'operator', 'viewer'],
};

const repoRoot = `${import.meta.dir}/../../../..`;

function chainCalls(declaration: ts.VariableDeclaration): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  if (declaration.initializer) visit(declaration.initializer);
  return calls;
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

async function declaredRoles(): Promise<Record<string, readonly string[] | typeof SIGNED_OUT>> {
  const found: Record<string, readonly string[] | typeof SIGNED_OUT> = {};
  for await (const path of new Bun.Glob('src/**/*.{ts,tsx}').scan(repoRoot)) {
    if (path.includes('/__tests__/')) continue;
    const text = await Bun.file(`${repoRoot}/${path}`).text();
    if (!text.includes('createServerFn(')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) {
        const calls = chainCalls(node);
        if (calls.some((call) => calleeName(call) === 'createServerFn')) {
          const roleCalls = calls.filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'roleMiddleware');
          found[`${path}:${node.name.getText(source)}`] = roleCalls.length === 0
            ? SIGNED_OUT
            : roleCalls.flatMap((call) => call.arguments.map((arg) => (ts.isStringLiteral(arg) ? arg.text : arg.getText(source))));
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('server function roles', () => {
  it('match the reviewed list, so a new function or a role change updates this table in the same PR', async () => {
    expect(await declaredRoles()).toEqual(EXPECTED);
  });

});
