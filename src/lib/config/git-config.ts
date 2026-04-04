import { z } from 'zod';
import { join } from 'node:path';

const GitConfigSchema = z.object({
  reposDir: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  repoPath: z.string().trim().min(1),
});

export type GitConfig = z.infer<typeof GitConfigSchema>;

/**
 * Load git management configuration from environment variables.
 *
 * @returns Validated git configuration
 */
export function loadGitConfig(): GitConfig {
  const reposDir = process.env.GIT_REPOS_DIR || '/data/repos';
  const repoName = 'stacks';
  const repoPath = join(reposDir, `${repoName}.git`);

  return GitConfigSchema.parse({ reposDir, repoName, repoPath });
}
