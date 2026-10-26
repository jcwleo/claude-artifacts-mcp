import { describe, expect, test } from "bun:test";
import {
  EMPTY_SIGNATURE,
  PICKUP_GRACE_MS,
  STALL_MS,
  type SessionEvent,
  classifyTurn,
  frameFileUrl,
  isRealPrompt,
  latestAssistantText,
  parseDesignLocation,
  realPromptCount,
  signature,
} from "../src/claude.ts";

const NOW = Date.parse("2026-10-26T08:00:00Z");
const idle = { worker_status: "idle", status_bucket: "completed" };

function event(sequence: number, payload: SessionEvent["payload"]): SessionEvent {
  return { sequence_num: String(sequence), payload };
}

describe("classifyTurn", () => {
  test("pending tool permission is awaiting_input with the tool names", () => {
    const result = classifyTurn({
      session: { worker_status: "running", requires_action_details_list: [{ tool_name: "Bash" }, {}] },
      signature: "x",
      baseline: "x",
      submittedAt: NOW,
      now: NOW,
    });
    expect(result).toEqual({ status: "awaiting_input", reason: "permission", pendingTools: ["Bash", "unknown"] });
  });

  test("a running worker is generating until its last event is older than the stall window", () => {
    const recent = new Date(NOW - 1000).toISOString();
    const old = new Date(NOW - STALL_MS - 1000).toISOString();
    const base = { signature: "a", baseline: "a", submittedAt: NOW, now: NOW };
    expect(classifyTurn({ ...base, session: { worker_status: "running", last_event_at: recent } }).status).toBe("generating");
    expect(classifyTurn({ ...base, session: { worker_status: "running", last_event_at: old } }).status).toBe("stalled");
  });

  test("an idle finished worker with changed files is done", () => {
    expect(classifyTurn({ session: idle, signature: "new", baseline: "old", submittedAt: NOW - 60_000, now: NOW })).toEqual({ status: "done" });
  });

  test("a blocked turn without file changes is a question for the user", () => {
    const result = classifyTurn({
      session: { worker_status: "idle", status_bucket: "blocked", post_turn_summary: { needs_action: "Which color palette?" } },
      signature: "same",
      baseline: "same",
      submittedAt: NOW - 60_000,
      now: NOW,
    });
    expect(result).toEqual({ status: "awaiting_input", reason: "question", question: "Which color palette?" });
  });

  test("an idle worker right after submission is still generating, later it is no_output", () => {
    const base = { session: idle, signature: "same", baseline: "same", now: NOW };
    expect(classifyTurn({ ...base, submittedAt: NOW - PICKUP_GRACE_MS + 1000 }).status).toBe("generating");
    expect(classifyTurn({ ...base, submittedAt: NOW - PICKUP_GRACE_MS - 1000 }).status).toBe("no_output");
  });

  test("an empty artifact never counts as done", () => {
    expect(classifyTurn({ session: idle, signature: EMPTY_SIGNATURE, baseline: null, submittedAt: null, now: NOW }).status).toBe("no_output");
  });
});

describe("session events", () => {
  const events = [
    event(1, { type: "user", message: { content: "<local-command-stdout>Set model</local-command-stdout>" } }),
    event(2, { type: "user", message: { content: [{ type: "text", text: "Design a dashboard" }] } }),
    event(3, { type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } }),
    event(4, { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    event(5, { type: "user", isSynthetic: true, message: { content: "continue" } }),
    event(6, { type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text", text: "Done: three directions." }] } }),
  ];

  test("only typed prompts count as real prompts", () => {
    expect(events.map(isRealPrompt)).toEqual([false, true, false, false, false, false]);
    expect(realPromptCount(events)).toBe(1);
  });

  test("latestAssistantText joins assistant text after the last prompt in sequence order", () => {
    expect(latestAssistantText([...events].reverse())).toBe("Working on it.\n\nDone: three directions.");
  });
});

describe("manifest helpers", () => {
  test("signature covers project files only and ignores order", () => {
    const files = [
      { path: "project/a.dc.html", sha256: "1" },
      { path: "project/b.css", sha256: "2" },
      { path: "artifact-type/dc-runtime.js", sha256: "3" },
    ];
    const shuffled = [files[2]!, files[1]!, files[0]!];
    expect(signature(files)).toBe(signature(shuffled));
    expect(signature(files)).not.toBe(signature([{ path: "project/a.dc.html", sha256: "9" }, files[1]!]));
    expect(signature([files[2]!])).toBe(EMPTY_SIGNATURE);
  });

  test("frameFileUrl encodes each path segment and the token", () => {
    expect(frameFileUrl("abc", "v1", "project/My Board.dc.html", "t+k")).toBe(
      "https://abc.frame.claudeusercontent.com/_f/v1/project/My%20Board.dc.html?__frame_t=t%2Bk",
    );
  });
});

describe("parseDesignLocation", () => {
  test("reads the Cowork session and artifact ids", () => {
    expect(
      parseDesignLocation("https://claude.ai/cowork/cse_01ExampleSessionId0000?artifact=11111111-2222-4333-8444-555555555555"),
    ).toEqual({ sessionId: "cse_01ExampleSessionId0000", projectId: "11111111-2222-4333-8444-555555555555" });
  });

  test("rejects pages that are not a design session", () => {
    expect(parseDesignLocation("https://claude.ai/artifacts/design")).toBeNull();
    expect(parseDesignLocation("https://claude.ai/cowork/cse_1?artifact=not-a-uuid")).toBeNull();
    expect(parseDesignLocation("not a url")).toBeNull();
  });
});
