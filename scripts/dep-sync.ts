/**
 * Single source of truth for dependencies shared across the three packages
 * (root, agent, agent-updater): the root package.json. The agent is not a
 * workspace member on purpose (see CLAUDE.md), so there is no shared lockfile;
 * this script keeps the three package.json manifests in lockstep instead.
 *
 *   bun run deps:check   fail if any package's shared dep differs from root
 *   bun run deps:sync    copy root's versions into the other manifests
 *                        and reinstall the affected packages
 */
import { $ } from "bun";

const PACKAGES = ["package.json", "agent/package.json", "agent-updater/package.json"];
const SHARED_DEPS = ["dockerode", "jose", "zod", "@types/dockerode", "@types/bun", "typescript"];

type Deps = Record<string, string>;

async function readManifest(path: string): Promise<{ deps: Deps; raw: any }> {
  const raw = await Bun.file(path).json();
  return { deps: { ...raw.dependencies, ...raw.devDependencies }, raw };
}

function exact(version: string): boolean {
  return !/^[~^><*]/.test(version);
}

const manifests = new Map<string, Awaited<ReturnType<typeof readManifest>>>();
for (const path of PACKAGES) manifests.set(path, await readManifest(path));

const root = manifests.get("package.json")!.deps;

if (process.argv[2] === "--apply") {
  for (const path of PACKAGES.slice(1)) {
    const { deps, raw } = manifests.get(path)!;
    let changed = false;
    for (const name of SHARED_DEPS) {
      if (name in deps && deps[name] !== root[name]) {
        deps[name] = root[name];
        changed = true;
      }
    }
    if (!changed) continue;
    const target = raw.dependencies;
    for (const name of SHARED_DEPS) {
      if (target?.[name]) target[name] = root[name];
      if (raw.devDependencies?.[name]) raw.devDependencies[name] = root[name];
    }
    await Bun.write(path, JSON.stringify(raw, null, 2) + "\n");
    console.log(`updated ${path}, reinstalling`);
    await $`bun install`.cwd(path.split("/")[0] || ".");
  }
  console.log("synced");
} else {
  const problems: string[] = [];
  for (const path of PACKAGES) {
    const { deps } = manifests.get(path)!;
    for (const name of SHARED_DEPS) {
      if (!(name in deps)) continue;
      if (deps[name] !== root[name]) {
        problems.push(`${path}: ${name} is ${deps[name]}, root has ${root[name]}`);
      } else if (!exact(deps[name])) {
        problems.push(`${path}: ${name} is ${deps[name]}, shared deps must be exact`);
      }
    }
  }
  if (problems.length > 0) {
    console.error("dependency drift detected (fix: bun run deps:sync):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`all shared deps match root across ${PACKAGES.length} packages`);
}
