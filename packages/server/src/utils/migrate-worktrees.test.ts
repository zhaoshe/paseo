import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import os from "os";
import { join } from "path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBackedWorkspaceRegistry } from "../server/workspace-registry.js";
import {
  migrateAgentRecords,
  migrateWorkspaceRegistry,
  migrateWorktreesBaseRoot,
} from "./migrate-worktrees.js";

const silentLogger = pino({ level: "silent" });

describe("migrateWorktreesBaseRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), "paseo-worktree-migrate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports movesCommitted when the source root does not exist", async () => {
    const result = await migrateWorktreesBaseRoot(join(tmp, "missing"), join(tmp, "dest"));
    expect(result.movedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.movesCommitted).toBe(true);
  });

  it("moves project directories and reports movesCommitted", async () => {
    const from = join(tmp, "from");
    const to = join(tmp, "to");
    mkdirSync(join(from, "hash1", "wt-a"), { recursive: true });
    writeFileSync(join(from, "hash1", "wt-a", "file.txt"), "content");

    const result = await migrateWorktreesBaseRoot(from, to);

    expect(result.movesCommitted).toBe(true);
    expect(existsSync(join(to, "hash1", "wt-a", "file.txt"))).toBe(true);
    expect(existsSync(join(from, "hash1"))).toBe(false);
  });
});

describe("migrateAgentRecords", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), "paseo-agent-migrate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("updates cwd and renames directory for matching agent records", async () => {
    const agentsDir = join(tmp, "agents");
    const oldDirName = "Users-old-worktrees-abc123-myproject";
    const projectDir = join(agentsDir, oldDirName);
    mkdirSync(projectDir, { recursive: true });

    const record = {
      id: "agent-1",
      provider: "claude",
      cwd: "/Users/old/worktrees/abc123/myproject",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(projectDir, "agent-1.json"), JSON.stringify(record, null, 2) + "\n");

    const errors = await migrateAgentRecords(
      agentsDir,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );

    expect(errors).toHaveLength(0);

    const newDirPath = join(agentsDir, "Users-new-worktrees-abc123-myproject");
    expect(existsSync(newDirPath)).toBe(true);
    expect(existsSync(join(agentsDir, oldDirName))).toBe(false);

    const updated = JSON.parse(await readFile(join(newDirPath, "agent-1.json"), "utf8")) as {
      cwd: string;
    };
    expect(updated.cwd).toBe("/Users/new/worktrees/abc123/myproject");
  });

  it("merges into an existing destination directory instead of failing", async () => {
    const agentsDir = join(tmp, "agents");
    const oldDir = join(agentsDir, "Users-old-worktrees-abc123-myproject");
    const newDir = join(agentsDir, "Users-new-worktrees-abc123-myproject");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    const oldRecord = {
      id: "agent-old",
      cwd: "/Users/old/worktrees/abc123/myproject",
    };
    const existingRecord = {
      id: "agent-new",
      cwd: "/Users/new/worktrees/abc123/myproject",
    };
    writeFileSync(join(oldDir, "agent-old.json"), JSON.stringify(oldRecord, null, 2) + "\n");
    writeFileSync(join(newDir, "agent-new.json"), JSON.stringify(existingRecord, null, 2) + "\n");

    const errors = await migrateAgentRecords(
      agentsDir,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );

    expect(errors).toHaveLength(0);
    expect(existsSync(join(newDir, "agent-old.json"))).toBe(true);
    expect(existsSync(join(newDir, "agent-new.json"))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);

    const migrated = JSON.parse(await readFile(join(newDir, "agent-old.json"), "utf8")) as {
      cwd: string;
    };
    expect(migrated.cwd).toBe("/Users/new/worktrees/abc123/myproject");
  });

  it("ignores records whose cwd is not under fromBase", async () => {
    const agentsDir = join(tmp, "agents");
    const projectDir = join(agentsDir, "Users-other-worktrees-xyz");
    mkdirSync(projectDir, { recursive: true });

    const record = {
      id: "agent-2",
      provider: "claude",
      cwd: "/Users/other/worktrees/xyz",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(projectDir, "agent-2.json"), JSON.stringify(record, null, 2) + "\n");

    const errors = await migrateAgentRecords(
      agentsDir,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );

    expect(errors).toHaveLength(0);
    const unchanged = JSON.parse(await readFile(join(projectDir, "agent-2.json"), "utf8")) as {
      cwd: string;
    };
    expect(unchanged.cwd).toBe("/Users/other/worktrees/xyz");
  });

  it("returns empty errors when agentsBaseDir does not exist", async () => {
    const errors = await migrateAgentRecords(join(tmp, "nonexistent"), "/from", "/to");
    expect(errors).toHaveLength(0);
  });
});

describe("migrateWorkspaceRegistry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), "paseo-workspace-migrate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildRegistry(records: object[]): FileBackedWorkspaceRegistry {
    const filePath = join(tmp, "workspaces.json");
    writeFileSync(filePath, JSON.stringify(records, null, 2) + "\n");
    return new FileBackedWorkspaceRegistry(filePath, silentLogger);
  }

  function workspaceRecord(
    cwd: string,
    archivedAt: string | null = null,
    workspaceId = `wks_${cwd.split("/").at(-1)}`,
  ) {
    return {
      workspaceId,
      projectId: "remote:github.com/org/repo",
      cwd,
      kind: "worktree" as const,
      displayName: "my-branch",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt,
    };
  }

  it("repoints matching workspaces, clears archivedAt, and preserves the opaque id", async () => {
    const registry = buildRegistry([
      workspaceRecord("/Users/old/worktrees/abc/proj", "2026-01-02T00:00:00.000Z", "wks_opaque"),
      workspaceRecord("/Users/other/repo"),
    ]);

    const errors = await migrateWorkspaceRegistry(
      registry,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );

    expect(errors).toHaveLength(0);
    const records = await registry.list();
    expect(records).toHaveLength(2);

    const migrated = records.find((r) => r.cwd === "/Users/new/worktrees/abc/proj");
    expect(migrated).toBeDefined();
    expect(migrated?.workspaceId).toBe("wks_opaque");
    expect(migrated?.archivedAt).toBeNull();
    expect(records.find((r) => r.cwd === "/Users/old/worktrees/abc/proj")).toBeUndefined();

    const untouched = records.find((r) => r.cwd === "/Users/other/repo");
    expect(untouched).toBeDefined();
  });

  it("persists migrated records in a schema-valid form", async () => {
    const filePath = join(tmp, "workspaces.json");
    writeFileSync(
      filePath,
      JSON.stringify(
        [workspaceRecord("/Users/old/worktrees/abc/proj", "2026-01-02T00:00:00.000Z")],
        null,
        2,
      ) + "\n",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, silentLogger);

    const errors = await migrateWorkspaceRegistry(
      registry,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );
    expect(errors).toHaveLength(0);

    // A fresh registry instance re-parses the persisted file with the Zod schema;
    // an invalid shape (e.g. a missing archivedAt key) would come back empty.
    const reloaded = new FileBackedWorkspaceRegistry(filePath, silentLogger);
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.cwd).toBe("/Users/new/worktrees/abc/proj");
    expect(records[0]?.archivedAt).toBeNull();
  });

  it("leaves non-matching workspaces untouched", async () => {
    const registry = buildRegistry([workspaceRecord("/Users/other/repo")]);

    const errors = await migrateWorkspaceRegistry(
      registry,
      "/Users/old/worktrees",
      "/Users/new/worktrees",
    );

    expect(errors).toHaveLength(0);
    const records = await registry.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.cwd).toBe("/Users/other/repo");
  });

  it("returns empty errors for an empty registry", async () => {
    const registry = new FileBackedWorkspaceRegistry(join(tmp, "nonexistent.json"), silentLogger);
    const errors = await migrateWorkspaceRegistry(registry, "/from", "/to");
    expect(errors).toHaveLength(0);
  });
});
