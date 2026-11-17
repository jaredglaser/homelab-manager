import type { AgentRouteErrorBody, AgentRouteFailureCode } from '../types';

export function routeErrorBody(code: AgentRouteFailureCode, error: string): AgentRouteErrorBody {
  return { error, code };
}
