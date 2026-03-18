import { z } from 'zod';
import { join } from 'path';

const GitConfigSchema = z.object({
  enabled: z.boolean(),
  reposDir: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  repoPath: z.string().trim().min(1),
});

export type GitConfig = z.infer<typeof GitConfigSchema>;

/**
 * Load git management configuration from environment variables.
 * The `enabled` field reflects whether DOCKER_MANAGEMENT_FEATURE_FLAG is 'true'.
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
