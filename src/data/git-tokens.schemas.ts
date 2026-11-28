import { z } from 'zod';

export const GIT_TOKEN_LABEL_MAX_LENGTH = 100;

export const createGitTokenSchema = z.object({
  label: z.string()
    .min(1, 'Enter a label for this token.')
    .max(GIT_TOKEN_LABEL_MAX_LENGTH, `Use ${GIT_TOKEN_LABEL_MAX_LENGTH} characters or fewer.`),
});
