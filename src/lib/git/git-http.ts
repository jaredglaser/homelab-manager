const VALID_ACTIONS = ['info/refs', 'git-upload-pack', 'git-receive-pack'] as const;
type GitAction = (typeof VALID_ACTIONS)[number];

export interface GitPathInfo {
  repo: string;
  action: GitAction;
}

/**
 * Parse a Git HTTP path like `/api/git/stacks/info/refs` into repo name and action.
 */
export function parseGitPath(pathname: string): GitPathInfo | null {
  // Remove the /api/git/ prefix
  const prefix = '/api/git/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const rest = pathname.slice(prefix.length);

  // Try each valid action (longest first to match info/refs before other patterns)
  for (const action of VALID_ACTIONS) {
    if (rest.endsWith(`/${action}`)) {
      const repo = rest.slice(0, -(action.length + 1));
      if (repo.length > 0) {
        return { repo, action };
      }
    }
  }

  return null;
}

export function isGitInfoRefsRequest(method: string, action: string): boolean {
  return method === 'GET' && action === 'info/refs';
}

export function isGitUploadPackRequest(method: string, action: string): boolean {
  return method === 'POST' && action === 'git-upload-pack';
}

export function isGitReceivePackRequest(method: string, action: string): boolean {
  return method === 'POST' && action === 'git-receive-pack';
}
