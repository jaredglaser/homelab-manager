#!/usr/bin/env bun
/**
 * Reads sonar-issues.json, groups issues by rule/file/directory,
 * selects the best group to fix, and writes:
 *   selected-issues.json  — issues for Claude Code to fix
 *   triage-summary.md     — human-readable summary for the PR description
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

const MAX_ISSUES = Math.min(Math.max(1, Number(process.env.MAX_ISSUES ?? "10") || 10), 50);
const INPUT_FILE = process.env.INPUT_FILE ?? "sonar-issues.json";
const SELECTED_FILE = process.env.SELECTED_FILE ?? "selected-issues.json";
const SUMMARY_FILE = process.env.SUMMARY_FILE ?? "triage-summary.md";

interface SonarIssue {
  key: string;
  rule: string;
  severity: string;
  type: string;
  component: string;
  line?: number;
  message: string;
  effort?: string;
  debt?: string;
  tags?: string[];
}

interface Group {
  label: string;
  groupType: "rule" | "file" | "directory";
  groupKey: string;
  issues: SonarIssue[];
}

// Safety rails: never auto-fix these
const BLOCKED_SEVERITIES = new Set(["CRITICAL", "BLOCKER"]);
const BLOCKED_TYPES = new Set(["VULNERABILITY", "SECURITY_HOTSPOT"]);

function isSafe(issue: SonarIssue): boolean {
  return !BLOCKED_SEVERITIES.has(issue.severity) && !BLOCKED_TYPES.has(issue.type);
}

function componentToPath(component: string): string {
  // SonarQube components look like "projectKey:src/foo/bar.ts"
  const colonIdx = component.indexOf(":");
  return colonIdx === -1 ? component : component.slice(colonIdx + 1);
}

function groupIssues(issues: SonarIssue[]): Group[] {
  const safe = issues.filter(isSafe);

  // 1. Group by rule
  const byRule = new Map<string, SonarIssue[]>();
  for (const issue of safe) {
    const existing = byRule.get(issue.rule) ?? [];
    existing.push(issue);
    byRule.set(issue.rule, existing);
  }

  // 2. Group by file
  const byFile = new Map<string, SonarIssue[]>();
  for (const issue of safe) {
    const path = componentToPath(issue.component);
    const existing = byFile.get(path) ?? [];
    existing.push(issue);
    byFile.set(path, existing);
  }

  // 3. Group by directory
  const byDir = new Map<string, SonarIssue[]>();
  for (const issue of safe) {
    const path = componentToPath(issue.component);
    const dir = dirname(path);
    const existing = byDir.get(dir) ?? [];
    existing.push(issue);
    byDir.set(dir, existing);
  }

  const groups: Group[] = [];

  for (const [rule, ruleIssues] of byRule) {
    if (ruleIssues.length > 0) {
      groups.push({ label: `Rule ${rule}`, groupType: "rule", groupKey: rule, issues: ruleIssues });
    }
  }
  for (const [file, fileIssues] of byFile) {
    if (fileIssues.length > 1) {
      groups.push({ label: `File ${file}`, groupType: "file", groupKey: file, issues: fileIssues });
    }
  }
  for (const [dir, dirIssues] of byDir) {
    if (dirIssues.length > 1) {
      groups.push({ label: `Directory ${dir}`, groupType: "directory", groupKey: dir, issues: dirIssues });
    }
  }

  return groups;
}

function selectBestGroup(groups: Group[], maxIssues: number): Group | null {
  // Prefer rule groups (most cohesive), then file, then directory.
  // Within each type, pick the group with the most issues that fits under maxIssues.
  // Prefer CODE_SMELL over BUG.
  const typeOrder: Record<string, number> = { rule: 0, file: 1, directory: 2 };

  const candidates = groups
    .filter((g) => g.issues.length <= maxIssues)
    .sort((a, b) => {
      const typeScore = typeOrder[a.groupType] - typeOrder[b.groupType];
      if (typeScore !== 0) return typeScore;

      const aSmells = a.issues.filter((i) => i.type === "CODE_SMELL").length;
      const bSmells = b.issues.filter((i) => i.type === "CODE_SMELL").length;
      if (aSmells !== bSmells) return bSmells - aSmells; // more smells first

      return b.issues.length - a.issues.length; // more issues first
    });

  return candidates[0] ?? null;
}

function renderSummary(all: Group[], selected: Group | null, maxIssues: number): string {
  const lines: string[] = [
    "# SonarQube Auto-Fix Triage Summary",
    "",
    `**Max issues per PR:** ${maxIssues}`,
    `**Total safe groups found:** ${all.length}`,
    "",
    "## Selected Group",
    "",
  ];

  if (!selected) {
    lines.push("_No group selected — no group had ≤ max_issues safe issues._");
  } else {
    lines.push(`**Label:** ${selected.label}`);
    lines.push(`**Type:** ${selected.groupType}`);
    lines.push(`**Issue count:** ${selected.issues.length}`);
    lines.push("");
    lines.push("| # | Rule | Severity | File | Line | Message |");
    lines.push("|---|------|----------|------|------|---------|");
    for (const [i, issue] of selected.issues.entries()) {
      const path = componentToPath(issue.component);
      lines.push(
        `| ${i + 1} | \`${issue.rule}\` | ${issue.severity} | \`${path}\` | ${issue.line ?? "-"} | ${sanitizeString(issue.message)} |`
      );
    }
  }

  lines.push("", "## All Groups (sorted by priority)", "");
  const sortedGroups = [...all].sort((a, b) => {
    const typeOrder: Record<string, number> = { rule: 0, file: 1, directory: 2 };
    const typeScore = typeOrder[a.groupType] - typeOrder[b.groupType];
    if (typeScore !== 0) return typeScore;
    return b.issues.length - a.issues.length;
  });
  for (const g of sortedGroups) {
    const marker =
      selected && g.groupKey === selected.groupKey && g.groupType === selected.groupType ? " ✓ selected" : "";
    lines.push(`- **${g.label}**${marker}: ${g.issues.length} issues`);
  }

  lines.push("", "---", "_Generated by `.github/scripts/triage-issues.ts`_");
  return lines.join("\n");
}

function sanitizeString(input: string): string {
  // Truncate to 200 characters and strip characters outside the safe set
  // to defend against prompt injection via SonarQube API responses.
  return input.slice(0, 200).replace(/[^\w\s.,;:()'"-]/g, "");
}

function emitNoGroupOutput(outputFile: string | undefined): void {
  if (outputFile) {
    try {
      writeFileSync(outputFile, "rule_key=\nissue_count=0\ngroup_label=\n", { flag: "a" });
    } catch (err) {
      console.error(`ERROR: Failed to write to GITHUB_OUTPUT: ${err}`);
      process.exit(1);
    }
  }
}

// Main

let raw: string;
try {
  raw = readFileSync(INPUT_FILE, "utf-8");
} catch (err: unknown) {
  if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    console.error(`ERROR: Input file '${INPUT_FILE}' not found. Did the fetch step succeed?`);
  } else {
    console.error(`ERROR: Failed to read '${INPUT_FILE}': ${err}`);
  }
  process.exit(1);
}

let issues: SonarIssue[];
try {
  issues = JSON.parse(raw) as SonarIssue[];
} catch {
  console.error(`ERROR: '${INPUT_FILE}' is not valid JSON. The SonarQube fetch step may have failed silently.`);
  console.error(raw.slice(0, 500));
  process.exit(1);
}

console.log(`Loaded ${issues.length} issues from ${INPUT_FILE}`);

const groups = groupIssues(issues);
console.log(`Formed ${groups.length} groups`);

const selected = selectBestGroup(groups, MAX_ISSUES);

const outputFile = process.env.GITHUB_OUTPUT;

if (!selected) {
  console.error("No suitable group found within the max_issues limit.");
  try {
    writeFileSync(SELECTED_FILE, "[]");
    writeFileSync(SUMMARY_FILE, renderSummary(groups, null, MAX_ISSUES));
  } catch (err) {
    console.error(`ERROR: Failed to write output files: ${err}`);
    process.exit(1);
  }
  emitNoGroupOutput(outputFile);
  process.exit(0);
}

console.log(`Selected: ${selected.label} (${selected.issues.length} issues)`);

// Sanitize all string fields to defend against prompt injection
const sanitizedIssues = selected.issues.map((issue) => ({
  key: sanitizeString(issue.key),
  rule: sanitizeString(issue.rule),
  severity: sanitizeString(issue.severity),
  type: sanitizeString(issue.type),
  component: sanitizeString(issue.component),
  ...(issue.line !== undefined ? { line: issue.line } : {}),
  message: sanitizeString(issue.message),
}));

try {
  writeFileSync(SELECTED_FILE, JSON.stringify(sanitizedIssues, null, 2));
  writeFileSync(SUMMARY_FILE, renderSummary(groups, selected, MAX_ISSUES));
} catch (err) {
  console.error(`ERROR: Failed to write output files: ${err}`);
  process.exit(1);
}

// Emit the selected rule key and issue count for use as step outputs
if (process.env.GITHUB_ACTIONS === "true" && !outputFile) {
  console.error("ERROR: GITHUB_OUTPUT is not set. Cannot emit step outputs.");
  process.exit(1);
}

if (outputFile) {
  const ruleKey = selected.groupKey.replace(/[^a-zA-Z0-9-]/g, "-");
  const issueCount = selected.issues.length;
  const groupLabel = selected.label.replace(/\r?\n/g, " ");
  try {
    writeFileSync(outputFile, `rule_key=${ruleKey}\nissue_count=${issueCount}\ngroup_label=${groupLabel}\n`, {
      flag: "a",
    });
  } catch (err) {
    console.error(`ERROR: Failed to write to GITHUB_OUTPUT: ${err}`);
    process.exit(1);
  }
}

console.log(`Wrote ${SELECTED_FILE} and ${SUMMARY_FILE}`);
