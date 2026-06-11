import { describe, expect, it } from "vitest";
import {
  normalizeTerminalPresets,
  PaseoConfigRawSchema,
  PaseoConfigSchema,
} from "@getpaseo/protocol/paseo-config-schema";

describe("paseo config schema", () => {
  it("parses an empty config without metadata generation", () => {
    const parsed = PaseoConfigSchema.parse({});

    expect(parsed).toEqual({});
    expect(parsed.metadataGeneration).toBeUndefined();
  });

  it("parses old-style worktree and scripts config unchanged", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
          port: 5173,
        },
      },
    };

    expect(PaseoConfigSchema.parse(config)).toEqual({
      worktree: {
        setup: ["npm install"],
        teardown: ["npm run clean"],
      },
      scripts: config.scripts,
    });
  });

  it("parses all metadata generation instruction entries", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
          branchName: { instructions: "Prefix branches with feat/." },
          commitMessage: { instructions: "Use imperative mood." },
          pullRequest: { instructions: "Include risk notes." },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        branchName: { instructions: "Prefix branches with feat/." },
        commitMessage: { instructions: "Use imperative mood." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
  });

  it("parses partial metadata generation instructions with missing entries undefined", () => {
    const parsed = PaseoConfigSchema.parse({
      metadataGeneration: {
        agentTitle: { instructions: "Keep it short." },
      },
    });

    expect(parsed.metadataGeneration).toEqual({
      agentTitle: { instructions: "Keep it short." },
    });
    expect(parsed.metadataGeneration?.branchName).toBeUndefined();
    expect(parsed.metadataGeneration?.commitMessage).toBeUndefined();
    expect(parsed.metadataGeneration?.pullRequest).toBeUndefined();
  });

  it("passes through unknown metadata generation fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use concise titles." },
          futureField: 42,
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
        futureField: 42,
      },
    });
  });

  it("passes through unknown metadata generator entry fields", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: {
            instructions: "Use concise titles.",
            model: "haiku",
          },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {
          instructions: "Use concise titles.",
          model: "haiku",
        },
      },
    });
  });

  it("falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      PaseoConfigSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {},
      },
    });
  });

  it("raw schema preserves old-style config while accepting metadata generation", () => {
    const config = {
      worktree: {
        setup: "npm install",
        teardown: ["npm run clean"],
      },
      scripts: {
        dev: {
          type: "service",
          command: "npm run dev",
        },
      },
      metadataGeneration: {
        agentTitle: { instructions: "Use concise titles." },
      },
    };

    expect(PaseoConfigRawSchema.parse(config)).toEqual(config);
  });

  it("raw schema falls back to an empty metadata generator entry when instructions has an invalid type", () => {
    expect(
      PaseoConfigRawSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: 42 },
        },
      }),
    ).toEqual({
      metadataGeneration: {
        agentTitle: {},
      },
    });
  });

  it("parses valid terminal presets with optional cwd", () => {
    const parsed = PaseoConfigSchema.parse({
      worktree: {
        setup: "npm install",
        terminals: [
          { name: "Dev", command: "npm run dev" },
          { name: "Logs", command: "tail -f log.txt", cwd: "./logs" },
        ],
      },
    });

    expect(parsed.worktree?.terminals).toEqual([
      { name: "Dev", command: "npm run dev" },
      { name: "Logs", command: "tail -f log.txt", cwd: "./logs" },
    ]);
  });

  it("drops invalid terminal preset entries", () => {
    const parsed = PaseoConfigSchema.parse({
      worktree: {
        terminals: [
          { name: "Valid", command: "ls" },
          { name: "", command: "ls" },
          { name: "NoCommand" },
          "not an object",
          { name: 42, command: "ls" },
        ],
      },
    });

    expect(parsed.worktree?.terminals).toEqual([{ name: "Valid", command: "ls" }]);
  });

  it("omits terminals when none are configured", () => {
    const parsed = PaseoConfigSchema.parse({ worktree: { setup: "npm install" } });

    expect(parsed.worktree?.terminals).toBeUndefined();
  });

  it("raw schema round-trips terminal presets unchanged", () => {
    const config = {
      worktree: { terminals: [{ name: "Dev", command: "npm run dev" }] },
    };

    expect(PaseoConfigRawSchema.parse(config)).toEqual(config);
  });
});

describe("normalizeTerminalPresets", () => {
  it("returns an empty array for non-array input", () => {
    expect(normalizeTerminalPresets(undefined)).toEqual([]);
    expect(normalizeTerminalPresets(null)).toEqual([]);
    expect(normalizeTerminalPresets("nope")).toEqual([]);
  });

  it("trims name, command, and cwd", () => {
    expect(
      normalizeTerminalPresets([{ name: "  Dev  ", command: "  npm run dev  ", cwd: "  ./app  " }]),
    ).toEqual([{ name: "Dev", command: "npm run dev", cwd: "./app" }]);
  });

  it("drops cwd when blank", () => {
    expect(normalizeTerminalPresets([{ name: "Dev", command: "npm run dev", cwd: "   " }])).toEqual(
      [{ name: "Dev", command: "npm run dev" }],
    );
  });
});
