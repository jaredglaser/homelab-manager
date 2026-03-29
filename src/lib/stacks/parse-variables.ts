/** Parse Docker Compose variable references from compose content (supports ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err}, ${VAR:+alt}, ${VAR+alt}). */
export function parseVariables(content: string): string[] {
  const regex = /\$\{([a-zA-Z_]\w*)(?::?[-?+][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort((a, b) => a.localeCompare(b));
}
