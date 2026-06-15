import { existsSync, mkdirSync } from "fs";
import { dirname, join, normalize, resolve, sep } from "path";
import { readdir, readFile, rename, rmdir, writeFile } from "fs/promises";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../server/workspace-registry.js";
import { runGitCommand } from "./run-git-command.js";
import { projectDirNameFromCwd } from "./project-dir-name.js";
import { expandTilde } from "./path.js";

export interface MigrateWorktreesResult {
  movedCount: number;
  errors: string[];
  // False when phase-1 moves failed and were rolled back — record migration
  // must be skipped, since records would point at paths that don't exist.
  movesCommitted: boolean;
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

// Moves a single filesystem entry; returns an error string on failure, null on success.
// EEXIST/ENOTEMPTY means the destination already exists — treated as already-migrated, not an error.
async function moveEntry(from: string, to: string): Promise<string | null> {
  try {
    await rename(from, to);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return null;
    return `${from}: move failed — ${String(err)}`;
  }
}

// Moves the entire worktrees base from fromBase to toBase with all-or-nothing semantics.
//
// Each project-level directory is moved atomically via rename(). If any rename fails,
// all previously moved directories are renamed back before returning an error — leaving
// the filesystem exactly as it was before the call.
//
// When the destination already contains content for a given project dir (e.g. after a
// previous partial migration), we fall back to entry-by-entry moves for that dir only.
// Entry-by-entry fallbacks are not rolled back since the destination pre-existed.
//
// After all moves succeed, git worktree repair is run in each affected main repo.
export async function migrateWorktreesBaseRoot(
  fromBase: string,
  toBase: string,
): Promise<MigrateWorktreesResult> {
  const from = resolve(expandTilde(fromBase));
  const to = resolve(expandTilde(toBase));

  // Ensure destination exists even when there are no worktrees to move.
  mkdirSync(to, { recursive: true });

  if (!existsSync(from)) {
    // Nothing to move physically (e.g. dirs were already moved by hand) —
    // record migration may still be needed, so report moves as committed.
    return { movedCount: 0, errors: [], movesCommitted: true };
  }

  let projectHashDirNames: string[];
  try {
    const dirents = await readdir(from, { withFileTypes: true });
    projectHashDirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    return {
      movedCount: 0,
      errors: [`${from}: could not read source directory — ${String(err)}`],
      movesCommitted: false,
    };
  }

  // Phase 1: move project directories — roll back on any hard failure.
  const atomicallyMoved: Array<{ from: string; to: string }> = [];

  for (const projectHash of projectHashDirNames) {
    const oldProjectDir = join(from, projectHash);
    const newProjectDir = join(to, projectHash);

    try {
      await rename(oldProjectDir, newProjectDir);
      atomicallyMoved.push({ from: oldProjectDir, to: newProjectDir });
      continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTEMPTY / EEXIST: destination already exists with content — fall through to
      // entry-by-entry path, no rollback needed (pre-existing state).
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        // Hard failure — roll back everything moved so far and abort.
        const rollbackErrors = await rollbackMoves(atomicallyMoved);
        const moveError = `${oldProjectDir}: move failed — ${String(err)}`;
        return {
          movedCount: 0,
          errors: rollbackErrors.length > 0 ? [moveError, ...rollbackErrors] : [moveError],
          movesCommitted: false,
        };
      }
    }

    // Entry-by-entry fallback when destination already exists.
    const fallbackErrors = await moveProjectDirEntries(oldProjectDir, newProjectDir);
    if (fallbackErrors.length > 0) {
      const rollbackErrors = await rollbackMoves(atomicallyMoved);
      return {
        movedCount: 0,
        errors: [...fallbackErrors, ...rollbackErrors],
        movesCommitted: false,
      };
    }
  }

  // Phase 2: discover worktrees and run git repair (moves already committed, no rollback).
  const errors: string[] = [];
  let movedCount = 0;
  const repairMap = new Map<string, string[]>();

  for (const projectHash of projectHashDirNames) {
    const newProjectDir = join(to, projectHash);
    let entries: string[];
    try {
      const dirents = await readdir(newProjectDir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => join(newProjectDir, d.name));
    } catch {
      continue;
    }
    for (const entryPath of entries) {
      try {
        const gitFileContent = await readFile(join(entryPath, ".git"), "utf8");
        const gitdirTarget = parseGitdirTarget(gitFileContent);
        if (!gitdirTarget) continue;
        const mainRepoRoot = deriveMainRepoRoot(gitdirTarget);
        const existing = repairMap.get(mainRepoRoot) ?? [];
        existing.push(entryPath);
        repairMap.set(mainRepoRoot, existing);
        movedCount++;
      } catch {
        // Not a worktree — skip silently.
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

  return { movedCount, errors, movesCommitted: true };
}

async function rollbackMoves(moved: Array<{ from: string; to: string }>): Promise<string[]> {
  const errors: string[] = [];
  for (const { from: movedFrom, to: movedTo } of moved.toReversed()) {
    try {
      await rename(movedTo, movedFrom);
    } catch (err) {
      errors.push(`Rollback failed: ${movedTo} → ${movedFrom}: ${String(err)}`);
    }
  }
  return errors;
}

async function moveProjectDirEntries(
  oldProjectDir: string,
  newProjectDir: string,
): Promise<string[]> {
  mkdirSync(newProjectDir, { recursive: true });
  let srcEntries: string[];
  try {
    const dirents = await readdir(oldProjectDir, { withFileTypes: true });
    srcEntries = dirents.map((d) => d.name);
  } catch (err) {
    return [`${oldProjectDir}: could not read source directory — ${String(err)}`];
  }
  const errors: string[] = [];
  for (const entryName of srcEntries) {
    const moveErr = await moveEntry(join(oldProjectDir, entryName), join(newProjectDir, entryName));
    if (moveErr) errors.push(moveErr);
  }
  return errors;
}

// Repoints workspace registry entries whose path was under `from` to `to`.
// Without this update, the workspace reconciliation service archives them
// (dir no longer exists) and sessions disappear from the main page.
//
// Must go through the live registry — it is a load-once in-memory cache that
// rewrites the whole file on every mutation, so editing workspaces.json behind
// its back gets clobbered by the next persist (e.g. the 60s reconciliation tick).
export async function migrateWorkspaceRegistry(
  registry: Pick<WorkspaceRegistry, "list" | "upsert" | "remove">,
  from: string,
  to: string,
): Promise<string[]> {
  const errors: string[] = [];
  const fromWithSep = from.endsWith(sep) ? from : from + sep;

  let records: PersistedWorkspaceRecord[];
  try {
    records = await registry.list();
  } catch (err) {
    return [`workspace registry: failed to list — ${String(err)}`];
  }

  for (const record of records) {
    const cwd = record.cwd;
    if (cwd !== from && !cwd.startsWith(fromWithSep)) continue;
    const newCwd = to + cwd.slice(from.length);
    const migrated: PersistedWorkspaceRecord = {
      ...record,
      workspaceId: newCwd,
      cwd: newCwd,
      // The directory now exists at the new path. Clear archivedAt so
      // workspaces archived by reconciliation (missing dir) resurface.
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    };
    try {
      await registry.upsert(migrated);
      if (record.workspaceId !== migrated.workspaceId) {
        await registry.remove(record.workspaceId);
      }
    } catch (err) {
      errors.push(`workspace ${record.workspaceId}: failed to migrate — ${String(err)}`);
    }
  }

  return errors;
}

// Updates the `cwd` field in all Paseo agent JSON records whose cwd was under
// `from`, repointing them to `to`, and renames each project directory to match
// the new cwd (AgentStorage derives the directory name from the record's cwd;
// keeping them consistent avoids stale-path directories accumulating).
export async function migrateAgentRecords(
  agentsBaseDir: string,
  from: string,
  to: string,
): Promise<string[]> {
  const errors: string[] = [];
  const fromWithSep = from.endsWith(sep) ? from : from + sep;

  let projectDirNames: string[];
  try {
    const dirents = await readdir(agentsBaseDir, { withFileTypes: true });
    projectDirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return errors;
  }

  for (const dirName of projectDirNames) {
    const projectDirPath = join(agentsBaseDir, dirName);
    let jsonFiles: string[];
    try {
      const dirents = await readdir(projectDirPath, { withFileTypes: true });
      jsonFiles = dirents
        .filter((d) => !d.isDirectory() && d.name.endsWith(".json"))
        .map((d) => join(projectDirPath, d.name));
    } catch {
      continue;
    }

    let newCwdForDir: string | undefined;
    for (const jsonFile of jsonFiles) {
      try {
        const content = await readFile(jsonFile, "utf8");
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null) continue;
        const cwd = (parsed as Record<string, unknown>).cwd;
        if (typeof cwd !== "string") continue;
        if (cwd !== from && !cwd.startsWith(fromWithSep)) continue;

        const newCwd = to + cwd.slice(from.length);
        newCwdForDir ??= newCwd;
        const updated = { ...(parsed as Record<string, unknown>), cwd: newCwd };
        await writeFile(jsonFile, JSON.stringify(updated, null, 2) + "\n");
      } catch (err) {
        errors.push(`${jsonFile}: failed to update agent record — ${String(err)}`);
      }
    }

    if (newCwdForDir !== undefined) {
      const newDirName = projectDirNameFromCwd(newCwdForDir);
      if (newDirName !== dirName) {
        const renameError = await renameOrMergeDir(projectDirPath, join(agentsBaseDir, newDirName));
        if (renameError) errors.push(renameError);
      }
    }
  }

  return errors;
}

// Renames a directory; when the destination already exists (e.g. agents were
// already created at the new path), merges entries into it instead.
async function renameOrMergeDir(fromDir: string, toDir: string): Promise<string | null> {
  try {
    await rename(fromDir, toDir);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") {
      return `${fromDir}: failed to rename agent directory — ${String(err)}`;
    }
  }
  const mergeErrors = await moveProjectDirEntries(fromDir, toDir);
  if (mergeErrors.length > 0) {
    return mergeErrors.join("; ");
  }
  // Best-effort cleanup of the now-empty source dir.
  await rmdir(fromDir).catch(() => undefined);
  return null;
}
