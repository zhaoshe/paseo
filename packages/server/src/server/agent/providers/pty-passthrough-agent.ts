import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentProvider,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ListModelsOptions,
} from "../agent-sdk-types.js";

/**
 * Generic "run any CLI in a terminal" provider — the zero-adapter fallback for
 * agents that have no dedicated Paseo integration. A custom provider declaring
 * `extends: "terminal"` runs its `command` as a one-shot filter per turn: the
 * prompt is written to the process stdin, stdout/stderr stream back as a
 * growing assistant message, and the turn completes when the process exits.
 *
 * Piped stdio (not a PTY) is deliberate — most CLIs emit clean, color-free text
 * when stdout is not a TTY, which maps directly onto Paseo's structured
 * timeline. ANSI sequences are still stripped as a safety net. Interactive TUI
 * agents are a poor fit for a structured timeline and should use the terminal
 * surface (or a dedicated adapter) instead.
 */

const TERMINATE_GRACEFUL_TIMEOUT_MS = 2000;
const TERMINATE_FORCE_TIMEOUT_MS = 2000;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

function promptToPlainText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

interface PtyPassthroughClientOptions {
  logger?: Logger;
  command: string[];
  env?: Record<string, string>;
  providerId: string;
  label?: string;
}

export class PtyPassthroughAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = CAPABILITIES;
  private readonly command: string[];
  private readonly env?: Record<string, string>;
  private readonly logger?: Logger;

  constructor(options: PtyPassthroughClientOptions) {
    this.provider = options.providerId;
    this.command = options.command;
    this.env = options.env;
    this.logger = options.logger;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return new PtyPassthroughAgentSession({
      provider: this.provider,
      sessionId: randomUUID(),
      command: this.command,
      cwd: config.cwd,
      env: this.env,
      logger: this.logger,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // No native resume — start a fresh session in the same directory.
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    return new PtyPassthroughAgentSession({
      provider: this.provider,
      sessionId: randomUUID(),
      command: this.command,
      cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      env: this.env,
      logger: this.logger,
    });
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return this.command.length > 0;
  }
}

interface PtyPassthroughSessionOptions {
  provider: AgentProvider;
  sessionId: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  logger?: Logger;
}

interface ActivePtyTurn {
  turnId: string;
  child: ChildProcess;
  resolve: (result: AgentRunResult) => void;
  completed: Promise<AgentRunResult>;
}

export class PtyPassthroughAgentSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  private readonly command: string[];
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly logger?: Logger;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly history: AgentStreamEvent[] = [];
  private activeTurn: ActivePtyTurn | null = null;

  constructor(options: PtyPassthroughSessionOptions) {
    this.provider = options.provider;
    this.id = options.sessionId;
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env;
    this.logger = options.logger;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const { turnId } = await this.startTurn(prompt, options);
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) {
      throw new Error("Terminal provider turn did not start");
    }
    return turn.completed;
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurn) {
      throw new Error("Terminal provider already has an active turn");
    }
    const turnId = randomUUID();
    const text = promptToPlainText(prompt);
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "user_message", text, messageId: randomUUID() },
    });

    const child = spawnProcess(this.command[0], this.command.slice(1), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.env ? { envOverlay: this.env } : {}),
    });

    let resolve!: (result: AgentRunResult) => void;
    const completed = new Promise<AgentRunResult>((promiseResolve) => {
      resolve = promiseResolve;
    });
    const turn: ActivePtyTurn = { turnId, child, resolve, completed };
    this.activeTurn = turn;

    const assistantMessageId = randomUUID();
    let output = "";
    const onChunk = (chunk: Buffer | string): void => {
      output += stripAnsi(chunk.toString());
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: output, messageId: assistantMessageId },
      });
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (error: Error) => {
      this.finishTurn(turn, { failedError: error.message, finalText: output });
    });
    child.on("exit", (code) => {
      this.finishTurn(turn, {
        failedError: code && code !== 0 ? `Process exited with code ${code}` : null,
        finalText: output,
      });
    });

    // Swallow EPIPE when the process exits before reading its stdin.
    child.stdin?.on("error", () => {});
    // One-shot filter: hand the prompt to the process and close stdin so a CLI
    // reading from stdin runs to completion.
    try {
      child.stdin?.write(text);
      child.stdin?.end();
    } catch (error) {
      this.logger?.warn({ err: error }, "Terminal provider failed to write prompt to stdin");
    }
    return { turnId };
  }

  private finishTurn(
    turn: ActivePtyTurn,
    result: { failedError: string | null; finalText: string },
  ): void {
    if (this.activeTurn?.turnId !== turn.turnId) {
      return;
    }
    this.activeTurn = null;
    if (result.failedError) {
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        error: result.failedError,
        turnId: turn.turnId,
      });
    } else {
      this.emit({ type: "turn_completed", provider: this.provider, turnId: turn.turnId });
    }
    turn.resolve({
      sessionId: this.id,
      finalText: result.finalText,
      timeline: [],
      canceled: false,
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.history) {
      yield event;
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {
    // No modes for a generic terminal agent.
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    // No permission flow — the underlying CLI manages its own approvals.
  }

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }

  getPid(): number | undefined {
    return this.activeTurn?.child.pid;
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.activeTurn = null;
    await terminateWithTreeKill(turn.child, {
      gracefulTimeoutMs: TERMINATE_GRACEFUL_TIMEOUT_MS,
      forceTimeoutMs: TERMINATE_FORCE_TIMEOUT_MS,
    });
    this.emit({
      type: "turn_canceled",
      provider: this.provider,
      reason: "Interrupted",
      turnId: turn.turnId,
    });
    turn.resolve({ sessionId: this.id, finalText: "", timeline: [], canceled: true });
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.listeners.clear();
  }

  private emit(event: AgentStreamEvent): void {
    this.history.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn({ err: error }, "Terminal provider listener failed");
      }
    }
  }
}
