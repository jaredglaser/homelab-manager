import { z } from 'zod';
import { join } from 'path';

const GitConfigSchema = z.object({
  enabled: z.boolean(),
  reposDir: z.string(),
  repoName: z.string(),
  repoPath: z.string(),
});

export type GitConfig = z.infer<typeof GitConfigSchema>;

/**
 * Load git management configuration from environment variables.
 * Only active when DOCKER_MANAGEMENT_FEATURE_FLAG is set.
 *
 * @returns Validated git configuration
 */
export function loadGitConfig(): GitConfig {
  const enabled = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
  const reposDir = process.env.GIT_REPOS_DIR || '/data/repos';
  const repoName = 'stacks';
  const repoPath = join(reposDir, `${repoName}.git`);

  return GitConfigSchema.parse({ enabled, reposDir, repoName, repoPath });
}
