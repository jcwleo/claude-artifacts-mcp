#!/usr/bin/env bun
import { isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { PreviewImage } from "./design.ts";
import { callDaemon } from "./ipc.ts";
import { STATE_DIR } from "./paths.ts";

const POLL_MS = 10_000;
const DEFAULT_WAIT_SEC = Number(process.env.CLAUDE_DESIGN_WAIT_SEC ?? 240);

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type CheckResult = Record<string, unknown> & { status?: string; projectId?: string };

const text = (value: unknown): Content => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
});

async function run(task: () => Promise<Content[]>) {
  try {
    return { content: await task() };
  } catch (error) {
    return { content: [text(error instanceof Error ? error.message : String(error))], isError: true };
  }
}

async function waitForTurn(projectId: string, timeoutSec: number): Promise<CheckResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const state = await callDaemon<CheckResult>("check", { projectId });
    if (state.status !== "generating") return state;
    if (Date.now() + POLL_MS > deadline) {
      return { ...state, note: "Claude Design is still generating. Call design_wait again with this projectId." };
    }
    await Bun.sleep(POLL_MS);
  }
}

async function previewContent(projectId: string, options: { file?: string; width?: number; maxImages?: number } = {}): Promise<Content[]> {
  const result = await callDaemon<Record<string, unknown> & { images: PreviewImage[] }>("preview", { projectId, ...options });
  const { images, ...rest } = result;
  return [
    text({ ...rest, images: images.map(({ data: _data, ...meta }) => meta) }),
    ...images.map((image): Content => ({ type: "image", data: image.data, mimeType: image.mimeType })),
  ];
}

async function settleAndShow(projectId: string, base: Record<string, unknown>, timeoutSec: number, preview: boolean): Promise<Content[]> {
  const state = await waitForTurn(projectId, timeoutSec);
  const summary = text({ ...base, ...state });
  if (state.status !== "done" || !preview) return [summary];
  try {
    return [summary, ...(await previewContent(projectId))];
  } catch (error) {
    return [summary, text(`Preview failed: ${error instanceof Error ? error.message : String(error)}`)];
  }
}

const waitShape = {
  wait: z.boolean().default(true).describe("Wait for Claude Design to finish before returning."),
  timeoutSec: z.number().int().min(10).max(1800).default(DEFAULT_WAIT_SEC).describe("How long to wait before returning a still-generating status."),
  preview: z.boolean().default(true).describe("Attach preview images when the design is done."),
};

const STATUS_GUIDE =
  "Statuses: generating (still working), done (files changed; previews attached), awaiting_input (reason permission: the user must open url and approve in claude.ai, never approve for them; reason question: answer with design_reply), no_output (turn ended without changing files), stalled (no activity for 10 minutes).";

const server = new McpServer({ name: "claude-design", version: "0.1.0" });

server.registerTool(
  "design_status",
  {
    title: "Claude Design status",
    description: "Check whether the dedicated design browser profile is signed in to claude.ai.",
    inputSchema: {},
  },
  () => run(async () => [text(await callDaemon("status", {}, 60_000))]),
);

server.registerTool(
  "design_login",
  {
    title: "Sign in to Claude Design",
    description:
      "Open a visible Chrome window with the dedicated design profile on claude.ai/login. The user signs in there and quits that window with Cmd+Q; then design_status reports loggedIn: true.",
    inputSchema: {},
  },
  () => run(async () => [text(await callDaemon("login", {}, 60_000))]),
);

server.registerTool(
  "design_list",
  {
    title: "List designs",
    description: "List the user's Claude Design designs (newest first) with their projectId and claude.ai URL.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  },
  ({ limit }) => run(async () => [text(await callDaemon("list", { limit }, 60_000))]),
);

server.registerTool(
  "design_create",
  {
    title: "Create a design",
    description: `Ask Claude Design (claude.ai Design artifact, on the user's own account) to generate a new design from a prompt, such as a web app screen or a dashboard. Claude Design itself produces the design; generation usually takes several minutes. Returns projectId, url, the status and, once done, preview images. ${STATUS_GUIDE}`,
    inputSchema: {
      prompt: z.string().min(1).describe("The design brief: goal, layout, content and audience."),
      name: z.string().min(1).max(80).optional().describe("Title for the design in claude.ai."),
      ...waitShape,
    },
  },
  ({ prompt, name, wait, timeoutSec, preview }) =>
    run(async () => {
      const created = await callDaemon<CheckResult>("create", { prompt, name }, 180_000);
      if (!wait) return [text(created)];
      return settleAndShow(String(created.projectId), created, timeoutSec, preview);
    }),
);

server.registerTool(
  "design_wait",
  {
    title: "Wait for a design",
    description: `Wait for Claude Design to finish the current turn of a design and return its status, Claude's reply and preview images. ${STATUS_GUIDE}`,
    inputSchema: {
      projectId: z.string().min(1),
      timeoutSec: waitShape.timeoutSec,
      preview: waitShape.preview,
    },
  },
  ({ projectId, timeoutSec, preview }) => run(() => settleAndShow(projectId, {}, timeoutSec, preview)),
);

server.registerTool(
  "design_reply",
  {
    title: "Revise a design",
    description: `Send a follow-up message to the Claude Design chat of an existing design: a revision request ("make the charts blue") or an answer to Claude's question. ${STATUS_GUIDE}`,
    inputSchema: {
      projectId: z.string().min(1),
      message: z.string().min(1),
      ...waitShape,
    },
  },
  ({ projectId, message, wait, timeoutSec, preview }) =>
    run(async () => {
      const sent = await callDaemon<CheckResult>("reply", { projectId, message }, 180_000);
      if (!wait) return [text(sent)];
      return settleAndShow(projectId, sent, timeoutSec, preview);
    }),
);

server.registerTool(
  "design_preview",
  {
    title: "Preview a design",
    description: "Render a design's artboards (.dc.html files) and return them as images.",
    inputSchema: {
      projectId: z.string().min(1),
      file: z.string().optional().describe("One project file to render, e.g. Main.dc.html. Default: every artboard."),
      width: z.number().int().min(320).max(4096).optional().describe("Viewport width in CSS pixels (default 1440)."),
      maxImages: z.number().int().min(1).max(8).optional().describe("Maximum number of artboards to render (default 4)."),
    },
  },
  ({ projectId, file, width, maxImages }) => run(() => previewContent(projectId, { file, width, maxImages })),
);

server.registerTool(
  "design_pull",
  {
    title: "Download a design",
    description:
      "Download a design's source files (.dc.html artboards, support.js runtime, uploaded assets) into a directory so they can be implemented in code. Pass an absolute dir inside the user's project.",
    inputSchema: {
      projectId: z.string().min(1),
      dir: z.string().optional().describe("Destination directory. Default: ~/.claude-design-mcp/designs/<projectId>."),
    },
  },
  ({ projectId, dir }) =>
    run(async () => {
      const target = dir ? (isAbsolute(dir) ? dir : resolve(process.cwd(), dir)) : join(STATE_DIR, "designs", projectId);
      return [text(await callDaemon("pull", { projectId, dir: target }, 180_000))];
    }),
);

await server.connect(new StdioServerTransport());
