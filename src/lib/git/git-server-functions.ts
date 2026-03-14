/**
 * Server functions for git operations.
 * These are called from the frontend via createServerFn (future task)
 * and contain the shared utility logic.
 *
 * All modules that use isomorphic-git, fs, or other server-only packages
 * must be dynamically imported inside the server function body.
 */

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: FileTreeNode[];
}

/**
 * Build a nested file tree structure from flat file paths.
 * Used by the UI to display the repository file browser.
 */
export function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          children: [],
        };
        currentLevel.push(existing);
      }
      currentLevel = existing.children;
    }
  }

  // Sort recursively: directories first, then alphabetically
  sortTree(root);
  return root;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  }
}
