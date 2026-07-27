/**
 * base64url(JSON{file, export}), the dev compiler's id format. Import-free and
 * outside `src/lib/mock` so `vite.config.ts` can reach it without pulling the
 * mock backend into the production build config. The ids are reversible, so
 * vite.config.ts installs this for the demo and MSW targets only.
 */
export function encodeFunctionId(file: string, exportName: string): string {
  const json = JSON.stringify({ file, export: exportName });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
