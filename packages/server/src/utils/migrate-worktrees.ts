import { existsSync, mkdirSync } from "fs";
import { basename, dirname, join, normalize } from "path";
import { readdir, readFile, rename } from "fs/promises";
import { runGitCommand } from "./run-git-command.js";

export interface MigrateWorktreesResult {
  movedCount: number;
  errors: string[];
}

function parseGitdirTarget(content: string): string | null {
  const match = content.trim().match(/^gitdir:\s*(.+)$/);
  return match ? normalize(match[1].trim()) : null;
}

// .git file in a linked worktree contains: "gitdir: /repo/.git/worktrees/<name>"
// Up 3 path components to get the main repo root.
function deriveMainRepoRoot(worktreeGitDir: string): string {
  return dirname(dirname(dirname(worktreeGitDir)));
}

// Moves all git worktrees from fromBase to toBase, preserving
// the <projectHash>/<slug> subdirectory structure, then runs
// `git worktree repair` in each affected main repo.
export async function migrateWorktreesBaseRoot(
  fromBase: string,
  toBase: string,
): Promise<MigrateWorktreesResult> {
  if (!existsSync(fromBase)) {
    return { movedCount: 0, errors: [] };
  }

  let projectHashDirs: string[];
  try {
    const dirents = await readdir(fromBase, { withFileTypes: true });
    projectHashDirs = dirents.filter((d) => d.isDirectory()).map((d) => join(fromBase, d.name));
  } catch {
    return { movedCount: 0, errors: [] };
  }

  const errors: string[] = [];
  let movedCount = 0;
  const repairMap = new Map<string, string[]>();

  for (const projectHashDir of projectHashDirs) {
    const projectHash = basename(projectHashDir);

    let slugDirs: string[];
    try {
      const dirents = await readdir(projectHashDir, { withFileTypes: true });
      slugDirs = dirents.filter((d) => d.isDirectory()).map((d) => join(projectHashDir, d.name));
    } catch {
      continue;
    }

    for (const oldWorktreePath of slugDirs) {
      const slug = basename(oldWorktreePath);
      const newProjectHashDir = join(toBase, projectHash);
      const newWorktreePath = join(newProjectHashDir, slug);

      let mainRepoRoot: string | null = null;
      try {
        const gitFileContent = await readFile(join(oldWorktreePath, ".git"), "utf8");
        const gitdirTarget = parseGitdirTarget(gitFileContent);
        if (gitdirTarget) {
          mainRepoRoot = deriveMainRepoRoot(gitdirTarget);
        }
      } catch {
        errors.push(`${oldWorktreePath}: could not read .git file`);
        continue;
      }

      if (!mainRepoRoot) {
        errors.push(`${oldWorktreePath}: could not parse .git file`);
        continue;
      }

      try {
        mkdirSync(newProjectHashDir, { recursive: true });
        await rename(oldWorktreePath, newWorktreePath);
        movedCount++;

        const existing = repairMap.get(mainRepoRoot) ?? [];
        existing.push(newWorktreePath);
        repairMap.set(mainRepoRoot, existing);
      } catch (err) {
        errors.push(`${oldWorktreePath}: move failed — ${String(err)}`);
      }
    }
  }

  for (const [mainRepoRoot, newPaths] of repairMap) {
    try {
      await runGitCommand(["worktree", "repair", ...newPaths], { cwd: mainRepoRoot });
    } catch (err) {
      errors.push(`git worktree repair in ${mainRepoRoot}: ${String(err)}`);
    }
  }

  return { movedCount, errors };
}
