import { http, HttpResponse } from 'msw';
import { fromJSON, toCrossJSONAsync } from 'seroval';

import * as dockerFns from '@/lib/mock/functions/docker.functions';
import * as zfsFns from '@/lib/mock/functions/zfs.functions';
import * as proxmoxFns from '@/lib/mock/functions/proxmox.functions';
import * as settingsFns from '@/lib/mock/functions/settings.functions';
import * as stacksFns from '@/lib/mock/functions/stacks.functions';
import * as authFns from '@/lib/mock/functions/auth.functions';
import * as hostsFns from '@/lib/mock/functions/hosts.functions';
import * as gitTokenFns from '@/lib/mock/functions/git-tokens.functions';
import { functionIdFromUrl, resolveFunctionName } from '@/lib/mock/handlers/function-id';

/** A server function invocation as decoded from the wire. */
interface ServerFnPayload {
  data?: unknown;
  context?: unknown;
}

type ServerFnMock = (payload: ServerFnPayload) => unknown | Promise<unknown>;

/**
 * Wrap a mock that takes the `{ data }` call shape (as the real server functions
 * do). The double assertion erases each mock's specific input type so they share
 * one dispatch signature; the wire payload is already validated upstream.
 */
function fn<P>(impl: (opts: P) => unknown | Promise<unknown>): ServerFnMock {
  return (payload) => impl(payload as unknown as P);
}

/** Wrap a mock that takes the raw `data` object instead of `{ data }`. */
function withData<D>(impl: (data: D) => unknown | Promise<unknown>): ServerFnMock {
  return (payload) => impl(payload.data as D);
}

/**
 * Maps each `createServerFn` export name to its demo implementation. The names
 * mirror the real server functions in `src/data/**`, so a call the app already
 * makes in production is intercepted here and answered with mock data instead of
 * reaching the (absent) backend.
 */
const registry: Record<string, ServerFnMock> = {
  // Docker
  getHistoricalDockerStats: fn(dockerFns.getHistoricalDockerStats),
  getDockerEntityIcons: fn(dockerFns.getDockerEntityIcons),
  getContainerHistory: fn(dockerFns.getContainerHistory),
  getContainerInfo: fn(dockerFns.getContainerInfo),
  updateContainerIcon: fn(dockerFns.updateContainerIcon),
  clearContainerIcon: fn(dockerFns.clearContainerIcon),
  controlContainer: fn(dockerFns.controlContainer),

  // ZFS
  getHistoricalZFSStats: fn(zfsFns.getHistoricalZFSStats),

  // Proxmox
  getHistoricalProxmoxStats: fn(proxmoxFns.getHistoricalProxmoxStats),
  testProxmoxConnection: fn(proxmoxFns.testProxmoxConnection),

  // Settings
  updateSetting: fn(settingsFns.updateSetting),

  // Stacks
  listStacks: fn(stacksFns.listStacks),
  getStackDetail: fn(stacksFns.getStackDetail),
  triggerDeploy: fn(stacksFns.triggerDeploy),
  resumeDeploy: fn(stacksFns.resumeDeploy),
  rejectDeploy: fn(stacksFns.rejectDeploy),
  getDeployHistory: fn(stacksFns.getDeployHistory),
  saveComposeFile: fn(stacksFns.saveComposeFile),
  updateStackIcon: fn(stacksFns.updateStackIcon),
  getStackVariables: fn(stacksFns.getStackVariables),
  getVariableValue: fn(stacksFns.getVariableValue),
  setVariableValue: fn(stacksFns.setVariableValue),
  deleteVariable: fn(stacksFns.deleteVariable),
  listManagedHostNames: fn(stacksFns.listManagedHostNames),
  createStack: fn(stacksFns.createStack),
  deleteStack: fn(stacksFns.deleteStack),
  updateStackSettings: fn(stacksFns.updateStackSettings),
  ensureVariablesExist: fn(stacksFns.ensureVariablesExist),
  controlStack: fn(stacksFns.controlStack),

  // Auth
  getSession: fn(authFns.getSession),
  listUsers: fn(authFns.listUsers),
  listSessions: fn(authFns.listSessions),
  revokeSession: fn(authFns.revokeSession),
  revokeAllUserSessions: fn(authFns.revokeAllUserSessions),
  getRoleMapping: fn(authFns.getRoleMapping),

  // Managed hosts (mocks take the raw data object)
  listHosts: fn(hostsFns.listHosts),
  verifyHost: withData(hostsFns.verifyHost),
  addHost: withData(hostsFns.addHost),
  registerExistingHost: withData(hostsFns.registerExistingHost),
  updateHost: withData(hostsFns.updateHost),
  removeHost: withData(hostsFns.removeHost),
  updateAgent: withData(hostsFns.updateAgent),
  checkHostHealth: withData(hostsFns.checkHostHealth),

  // Git tokens
  listGitTokens: fn(gitTokenFns.listGitTokens),
  createGitToken: fn(gitTokenFns.createGitToken),
  revokeGitToken: fn(gitTokenFns.revokeGitToken),
};

/**
 * Decode the seroval-serialized `{ data, context }` payload that TanStack Start
 * sends. GET requests carry it in the `payload` query param; POST requests in the
 * JSON body. Returns an empty payload when there is nothing to decode.
 */
async function decodePayload(request: Request): Promise<ServerFnPayload> {
  let raw: string | null = null;
  if (request.method === 'GET') {
    raw = new URL(request.url).searchParams.get('payload');
  } else {
    const text = await request.text();
    raw = text.length > 0 ? text : null;
  }
  if (!raw) return {};
  try {
    return (fromJSON(JSON.parse(raw)) as ServerFnPayload) ?? {};
  } catch {
    return {};
  }
}

export async function handleServerFn(request: Request): Promise<Response> {
  const segment = functionIdFromUrl(request.url);
  const name = segment ? resolveFunctionName(segment) : null;
  const mock = name ? registry[name] : undefined;

  if (!mock) {
    // No real backend exists in demo / e2e, so answer with null rather than
    // passing through (which would 404). The warning surfaces the missing mock
    // during test authoring.
    console.warn(`[mock] no handler for server function "${name ?? segment}"`);
    return serializedResponse(null);
  }

  const payload = await decodePayload(request);
  try {
    const result = await mock(payload);
    return serializedResponse(result);
  } catch (error) {
    // Keep parity with the real server: a thrown handler is delivered as the
    // envelope's `error`, which the client rethrows, rather than a raw 500.
    return serializedResponse(undefined, error);
  }
}

/**
 * Mirror the real server's success response exactly: a seroval cross-JSON body
 * of the `{ result, error, context }` envelope, plus the `x-tss-serialized`
 * header. TanStack's client middleware reads `.result` off that envelope (and
 * throws `.error`), so returning the bare value resolves the call to undefined.
 */
async function serializedResponse(
  result: unknown,
  error: unknown = undefined,
): Promise<Response> {
  const envelope = { result, error, context: {} };
  const crossJson = await toCrossJSONAsync(envelope, { refs: new Map() });
  return new HttpResponse(JSON.stringify(crossJson), {
    headers: {
      'Content-Type': 'application/json',
      'x-tss-serialized': 'true',
    },
  });
}

export const serverFunctionHandlers = [
  http.all(/\/_serverFn\//, ({ request }) => handleServerFn(request)),
];
