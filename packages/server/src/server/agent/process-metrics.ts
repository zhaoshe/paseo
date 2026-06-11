import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessMetrics {
  /** CPU usage as a percentage of one core (may exceed 100 on multicore). */
  cpuPercent: number;
  /** Resident set size in bytes. */
  memoryBytes: number;
  /** ISO 8601 timestamp of when the sample was taken. */
  sampledAt: string;
}

/**
 * Parse the output of `ps -o %cpu= -o rss= -p <pid>` into typed metrics. The
 * `=` suffixes suppress column headers, so a successful sample is a single line
 * like `  3.5 123456` (cpu percent, then RSS in kilobytes). Returns null for
 * empty or malformed output (e.g. the process exited between listing and
 * sampling).
 */
export function parsePsMetrics(stdout: string, sampledAt: string): ProcessMetrics | null {
  const line = stdout.trim().split("\n")[0]?.trim();
  if (!line) {
    return null;
  }
  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  const cpuPercent = Number.parseFloat(parts[0]);
  const rssKilobytes = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssKilobytes)) {
    return null;
  }
  return {
    cpuPercent,
    memoryBytes: rssKilobytes * 1024,
    sampledAt,
  };
}

/**
 * Sample CPU and memory for a single process via `ps`. POSIX-only — returns
 * null on Windows (metrics are an optional, best-effort signal) and whenever
 * the process has exited or `ps` fails.
 */
export async function sampleProcessMetrics(
  pid: number,
  sampledAt: string,
): Promise<ProcessMetrics | null> {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "%cpu=", "-o", "rss=", "-p", String(pid)]);
    return parsePsMetrics(stdout, sampledAt);
  } catch {
    return null;
  }
}
