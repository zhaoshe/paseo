import { describe, expect, it } from "vitest";
import { parsePsMetrics } from "./process-metrics.js";

const SAMPLED_AT = "2026-06-08T00:00:00.000Z";

describe("parsePsMetrics", () => {
  it("parses cpu percent and rss kilobytes into typed metrics", () => {
    expect(parsePsMetrics("  3.5 123456\n", SAMPLED_AT)).toEqual({
      cpuPercent: 3.5,
      memoryBytes: 123456 * 1024,
      sampledAt: SAMPLED_AT,
    });
  });

  it("reads only the first line when ps emits several", () => {
    expect(parsePsMetrics("12.0 2048\n0.0 1024\n", SAMPLED_AT)).toEqual({
      cpuPercent: 12,
      memoryBytes: 2048 * 1024,
      sampledAt: SAMPLED_AT,
    });
  });

  it("returns null for empty output (process already exited)", () => {
    expect(parsePsMetrics("", SAMPLED_AT)).toBeNull();
    expect(parsePsMetrics("\n  \n", SAMPLED_AT)).toBeNull();
  });

  it("returns null when a column is missing or non-numeric", () => {
    expect(parsePsMetrics("3.5", SAMPLED_AT)).toBeNull();
    expect(parsePsMetrics("abc def", SAMPLED_AT)).toBeNull();
  });
});
