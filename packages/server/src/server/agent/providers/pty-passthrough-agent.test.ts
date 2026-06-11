import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { PtyPassthroughAgentSession } from "./pty-passthrough-agent.js";

function collect(session: PtyPassthroughAgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

describe("PtyPassthroughAgentSession", () => {
  it("streams command stdout as a growing assistant message and completes the turn", async () => {
    const session = new PtyPassthroughAgentSession({
      provider: "terminal-test",
      sessionId: "session-1",
      command: ["cat"], // echoes stdin back to stdout, then exits when stdin closes
      cwd: process.cwd(),
    });
    const events = collect(session);

    const result = await session.run("hello world");

    expect(result.canceled).toBe(false);
    expect(result.finalText).toContain("hello world");
    expect(events.some((event) => event.type === "turn_started")).toBe(true);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    const assistant = events.find(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );
    expect(assistant).toBeDefined();
    if (assistant?.type === "timeline" && assistant.item.type === "assistant_message") {
      expect(assistant.item.text).toContain("hello world");
    }
  });

  it("emits exactly one user_message for the prompt", async () => {
    const session = new PtyPassthroughAgentSession({
      provider: "terminal-test",
      sessionId: "session-2",
      command: ["cat"],
      cwd: process.cwd(),
    });
    const events = collect(session);

    await session.run("the prompt");

    const userMessages = events.filter(
      (event) => event.type === "timeline" && event.item.type === "user_message",
    );
    expect(userMessages).toHaveLength(1);
  });

  it("reports a non-zero exit code as a failed turn", async () => {
    const session = new PtyPassthroughAgentSession({
      provider: "terminal-test",
      sessionId: "session-3",
      command: ["sh", "-c", "exit 3"],
      cwd: process.cwd(),
    });
    const events = collect(session);

    await session.run("ignored");

    expect(events.some((event) => event.type === "turn_failed")).toBe(true);
    expect(events.some((event) => event.type === "turn_completed")).toBe(false);
  });
});
