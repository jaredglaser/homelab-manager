import { z } from 'zod';
import yaml from 'js-yaml';

const StackEntrySchema = z.object({
  host: z.string().min(1),
  auto_deploy: z.boolean().default(false),
});

const ManifestSchema = z.object({
  stacks: z.record(z.string(), StackEntrySchema),
});

export type StackEntry = z.infer<typeof StackEntrySchema>;
export type StackManifest = z.infer<typeof ManifestSchema>;

/**
 * Parse and validate a manifest.yaml string.
 *
 * @param content - Raw YAML string
 * @returns Validated StackManifest
 * @throws {YAMLException} If YAML syntax is invalid
 * @throws {ZodError} If YAML structure doesn't match schema
 */
export function parseManifest(content: string): StackManifest {
  const parsed = yaml.load(content);
  return ManifestSchema.parse(parsed);
}
