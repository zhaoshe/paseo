import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  normalizeTerminalPresets,
  type PaseoTerminalPreset,
} from "@getpaseo/protocol/paseo-config-schema";

const EMPTY_PRESETS: readonly PaseoTerminalPreset[] = [];
const PRESETS_STALE_TIME = 30_000;

interface UseTerminalPresetsInput {
  client: DaemonClient | null;
  workspaceDirectory: string | null;
}

/**
 * Reads the active workspace's `paseo.json` and returns its terminal presets
 * (the `worktree.terminals` array). Presets let users quick-launch a predefined
 * command in a fresh terminal — see {@link normalizeTerminalPresets}.
 */
export function useTerminalPresets(input: UseTerminalPresetsInput): readonly PaseoTerminalPreset[] {
  const { client, workspaceDirectory } = input;
  const query = useQuery({
    queryKey: ["terminal-presets", workspaceDirectory] as const,
    enabled: Boolean(client && workspaceDirectory),
    staleTime: PRESETS_STALE_TIME,
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        return EMPTY_PRESETS;
      }
      const payload = await client.readProjectConfig(workspaceDirectory);
      if (!payload.ok) {
        return EMPTY_PRESETS;
      }
      return normalizeTerminalPresets(payload.config?.worktree?.terminals);
    },
  });
  return query.data ?? EMPTY_PRESETS;
}
