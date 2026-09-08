import { z } from 'zod';
import * as yaml from 'js-yaml';

const StackEntrySchema = z.strictObject({
  host: z.string().min(1),
  autoDeploy: z.boolean().default(false),
});

const ManifestSchema = z.strictObject({
  stacks: z.record(z.string(), StackEntrySchema),
});

export type StackEntry = z.infer<typeof StackEntrySchema>;
export type StackManifest = z.infer<typeof ManifestSchema>;

/**
 * Parse and validate a raw stack manifest YAML string. The manifest's filename
 * and serialization are owned by stack-repo-layout.ts; this module only knows
 * the schema.
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
