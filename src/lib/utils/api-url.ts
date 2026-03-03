/**
 * Prepend the Vite base path to an API route so SSE / fetch URLs work
 * correctly when the app is deployed under a sub-path (e.g. GitHub Pages).
 *
 * `import.meta.env.BASE_URL` always ends with `/` and the incoming `path`
 * always starts with `/`, so we strip the trailing slash from the base to
 * avoid a double-slash.
 */
export function apiUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}${path}`;
}
