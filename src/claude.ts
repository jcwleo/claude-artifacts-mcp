import { CLAUDE_ORIGIN } from "./paths.ts";

export interface Page {
  evaluate(script: string): Promise<unknown>;
}

export type Api = { page: Page; org: string };

type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };
type PageFetchResult = { status: number; json: unknown; text: string };

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

export class ClaudeHttpError extends Error {
  override name = "ClaudeHttpError";
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`claude.ai HTTP ${status} ${path}${detail ? `: ${detail}` : ""}`);
  }
}

export const LOGIN_HELP = "Not logged in to claude.ai in the design profile. Call design_login, sign in, then quit that Chrome window with Cmd+Q.";

export async function pageFetch(page: Page, path: string, init: FetchInit = {}): Promise<PageFetchResult> {
  const request = {
    url: `${CLAUDE_ORIGIN}${path}`,
    method: init.method ?? "GET",
    headers: { ...init.headers, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  };
  const script = `(async (req) => {
    const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: "include", signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text: text.slice(0, 500) };
  })(${JSON.stringify(request)})`;
  return (await page.evaluate(script)) as PageFetchResult;
}

async function call(api: Api, path: string, init: FetchInit): Promise<unknown> {
  const result = await pageFetch(api.page, path, init);
  if (result.status === 401) throw new NotLoggedInError(LOGIN_HELP);
  if (result.status < 200 || result.status >= 300) {
    throw new ClaudeHttpError(result.status, path.split("?")[0] ?? path, result.text);
  }
  return result.json;
}

export function frame(api: Api, method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
  const separator = pathAndQuery.includes("?") ? "&" : "?";
  return call(api, `${pathAndQuery}${separator}org=${encodeURIComponent(api.org)}`, {
    method,
    body,
    headers: { "x-frame-platform": "web", "x-frame-surface": "cowork", "x-frame-cp": "go" },
  });
}

export async function ccr(api: Api, method: string, path: string, body?: unknown): Promise<unknown> {
  const json = await call(api, path, {
    method,
    body: method === "GET" ? undefined : (body ?? {}),
    headers: {
      "anthropic-beta": "ccr-byoc-2025-07-29",
      "anthropic-version": "2023-06-01",
      "x-organization-uuid": api.org,
    },
  });
  const wrapped = json as { response_shape?: unknown } | null;
  return wrapped?.response_shape ?? json;
}

export type ManifestFile = { path: string; size?: number; contentType?: string; sha256: string };
export type Manifest = { ver: string; assetToken: string; title: string; updatedAt: string; files: ManifestFile[] };

export async function getManifest(api: Api, projectId: string): Promise<Manifest> {
  const raw = (await frame(api, "GET", `/api/frame/${encodeURIComponent(projectId)}?via=user_open&bk=initial&actor=id&vt=1`)) as {
    ver?: unknown;
    assetToken?: unknown;
    title?: unknown;
    updated_at?: unknown;
    files?: unknown;
  } | null;
  const files = raw?.files;
  if (
    !raw ||
    typeof raw.ver !== "string" ||
    typeof raw.assetToken !== "string" ||
    !Array.isArray(files) ||
    files.some((file) => typeof file?.path !== "string" || typeof file?.sha256 !== "string")
  ) {
    throw new TypeError(`Unexpected artifact manifest shape for ${projectId}`);
  }
  return {
    ver: raw.ver,
    assetToken: raw.assetToken,
    title: typeof raw.title === "string" ? raw.title : "",
    updatedAt: new Date(String(raw.updated_at)).toISOString(),
    files: files as ManifestFile[],
  };
}

export async function getManifestOrNull(api: Api, projectId: string): Promise<Manifest | null> {
  try {
    return await getManifest(api, projectId);
  } catch (error) {
    if (error instanceof ClaudeHttpError && error.status === 404) return null;
    throw error;
  }
}

export type ProjectFile = ManifestFile & { rel: string };

export function projectFiles(files: readonly ManifestFile[]): ProjectFile[] {
  return files
    .filter((file) => file.path.startsWith("project/"))
    .map((file) => ({ ...file, rel: file.path.slice("project/".length) }));
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export const EMPTY_SIGNATURE = sha256Hex("");

export function signature(files: readonly ManifestFile[]): string {
  const lines = projectFiles(files)
    .map((file) => `${file.rel}:${file.sha256}`)
    .sort();
  return sha256Hex(lines.join("\n"));
}

export function frameFileUrl(projectId: string, ver: string, path: string, assetToken: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://${projectId}.frame.claudeusercontent.com/_f/${encodeURIComponent(ver)}/${encodedPath}?__frame_t=${encodeURIComponent(assetToken)}`;
}

export type SessionState = {
  worker_status?: string;
  status_bucket?: string;
  requires_action_details_list?: Array<{ type?: string; tool_name?: string }>;
  last_event_at?: string;
  post_turn_summary?: { needs_action?: string; status_detail?: string };
  external_metadata?: { post_turn_summary?: { needs_action?: string; status_detail?: string } };
};

export type SessionEvent = {
  sequence_num: string | number;
  payload: {
    type: string;
    isSynthetic?: boolean;
    message?: { content?: unknown };
    subtype?: string;
    is_error?: boolean;
  };
};

export function getSession(api: Api, sessionId: string): Promise<SessionState> {
  return ccr(api, "GET", `/v1/code/sessions/${encodeURIComponent(sessionId)}`) as Promise<SessionState>;
}

export async function readEvents(api: Api, sessionId: string, maxEvents = 2000): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const page = (await ccr(api, "GET", `/v1/code/sessions/${encodeURIComponent(sessionId)}/events?limit=100${query}`)) as {
      data?: SessionEvent[];
      next_cursor?: string | null;
    };
    if (!Array.isArray(page?.data)) throw new TypeError("Unexpected session events page shape");
    events.push(...page.data.slice(0, maxEvents - events.length));
    cursor = page.next_cursor ?? null;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error(`Repeated session events cursor: ${cursor}`);
      seen.add(cursor);
    }
  } while (cursor !== null && events.length < maxEvents);
  return events;
}

const LOCAL_COMMAND = /^\s*<(local-command-[a-z]+|command-[a-z]+)>/;

export function promptText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => block?.type === "tool_result")) return null;
  const texts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
  return texts.length ? texts.join("\n") : null;
}

export function isRealPrompt(event: SessionEvent): boolean {
  const { payload } = event;
  if (payload.type !== "user" || payload.isSynthetic === true) return false;
  const text = promptText(payload.message?.content);
  return text !== null && !LOCAL_COMMAND.test(text);
}

function bySequence(events: readonly SessionEvent[]): SessionEvent[] {
  return [...events].sort((left, right) => {
    const a = BigInt(left.sequence_num);
    const b = BigInt(right.sequence_num);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function realPromptCount(events: readonly SessionEvent[]): number {
  return events.filter(isRealPrompt).length;
}

export function latestAssistantText(events: readonly SessionEvent[]): string | null {
  const ordered = bySequence(events);
  const lastPrompt = ordered.findLastIndex(isRealPrompt);
  const texts: string[] = [];
  for (const event of ordered.slice(lastPrompt + 1)) {
    if (event.payload.type !== "assistant") continue;
    const content = event.payload.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) texts.push(block.text.trim());
    }
  }
  return texts.length ? texts.join("\n\n") : null;
}

export type TurnStatus = "generating" | "stalled" | "awaiting_input" | "done" | "no_output";
export type TurnResult = {
  status: TurnStatus;
  reason?: "permission" | "question";
  question?: string;
  pendingTools?: string[];
};

const FINISHED_BUCKETS = new Set(["completed", "blocked", "review_ready"]);
export const STALL_MS = 10 * 60_000;
export const PICKUP_GRACE_MS = 30_000;

export function classifyTurn(input: {
  session: SessionState;
  signature: string;
  baseline: string | null;
  submittedAt: number | null;
  now: number;
}): TurnResult {
  const { session, now } = input;
  const pending = session.requires_action_details_list ?? [];
  if (pending.length) {
    return {
      status: "awaiting_input",
      reason: "permission",
      pendingTools: pending.map((item) => item.tool_name ?? item.type ?? "unknown"),
    };
  }
  const idle = session.worker_status === "idle" && FINISHED_BUCKETS.has(session.status_bucket ?? "");
  if (!idle) {
    const lastEvent = Date.parse(session.last_event_at ?? "");
    return { status: Number.isFinite(lastEvent) && now - lastEvent > STALL_MS ? "stalled" : "generating" };
  }
  const summary = session.post_turn_summary ?? session.external_metadata?.post_turn_summary;
  const question =
    session.status_bucket === "blocked"
      ? String(summary?.needs_action || summary?.status_detail || "Claude asked a follow-up question").slice(0, 500)
      : null;
  const changed = input.signature !== EMPTY_SIGNATURE && input.signature !== input.baseline;
  if (changed) return question ? { status: "done", question } : { status: "done" };
  if (question) return { status: "awaiting_input", reason: "question", question };
  if (input.submittedAt !== null && now - input.submittedAt < PICKUP_GRACE_MS) return { status: "generating" };
  return { status: "no_output" };
}

export function parseDesignLocation(href: string): { sessionId: string; projectId: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const session = /^\/cowork\/(cse_[A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
  const artifact = url.searchParams.get("artifact");
  if (!session || !artifact || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(artifact)) return null;
  return { sessionId: session, projectId: artifact };
}
