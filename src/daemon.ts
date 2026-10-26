import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { BrowserHost } from "./browser.ts";
import { NotLoggedInError } from "./claude.ts";
import { Designs } from "./design.ts";
import { SOCKET_PATH, STATE_DIR } from "./paths.ts";
import { type DaemonRequest, type DaemonResponse, LineDecoder, encodeLine } from "./protocol.ts";

const IDLE_MS = Number(process.env.CLAUDE_DESIGN_IDLE_MS ?? 30 * 60_000);
const BROWSER_IDLE_MS = Number(process.env.CLAUDE_DESIGN_BROWSER_IDLE_MS ?? 5 * 60_000);
const BROWSER_GONE = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;

const browser = new BrowserHost();
const designs = new Designs(browser);

type Params = Record<string, unknown>;

function requiredString(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(params: Params, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const handlers: Record<string, (params: Params) => Promise<unknown>> = {
  status: () => designs.status(),
  login: () => designs.login(),
  list: (params) => designs.list({ limit: optionalNumber(params, "limit") }),
  create: (params) => designs.create({ prompt: requiredString(params, "prompt"), name: optionalString(params, "name") }),
  reply: (params) => designs.reply({ projectId: requiredString(params, "projectId"), message: requiredString(params, "message") }),
  check: (params) => designs.check({ projectId: requiredString(params, "projectId") }),
  preview: (params) =>
    designs.preview({
      projectId: requiredString(params, "projectId"),
      file: optionalString(params, "file"),
      width: optionalNumber(params, "width"),
      maxImages: optionalNumber(params, "maxImages"),
    }),
  pull: (params) =>
    designs.pull({
      projectId: requiredString(params, "projectId"),
      dir: optionalString(params, "dir"),
      baseDir: optionalString(params, "baseDir"),
    }),
  annotate_open: (params) => designs.openAnnotation({ projectId: requiredString(params, "projectId"), file: optionalString(params, "file") }),
  annotate_wait: (params) =>
    designs.waitAnnotation({ annotationId: requiredString(params, "annotationId"), timeoutSec: optionalNumber(params, "timeoutSec") ?? 420 }),
};

const UNSERIALIZED = new Set(["annotate_wait"]);

let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;
let lastActivity = Date.now();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function handle(request: DaemonRequest): Promise<DaemonResponse> {
  const handler = handlers[request.method];
  if (!handler) return { id: request.id, ok: false, error: `Unknown method: ${request.method}` };
  inFlight++;
  lastActivity = Date.now();
  try {
    const call = () => handler(request.params ?? {});
    return { id: request.id, ok: true, result: await (UNSERIALIZED.has(request.method) ? call() : serialized(call)) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof NotLoggedInError) designs.reset();
    if (BROWSER_GONE.test(message)) {
      await browser.shutdown();
      designs.reset();
    }
    return { id: request.id, ok: false, error: message };
  } finally {
    inFlight--;
    lastActivity = Date.now();
  }
}

function socketInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(SOCKET_PATH);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

const server = net.createServer((socket) => {
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      let request: DaemonRequest;
      try {
        request = JSON.parse(line) as DaemonRequest;
      } catch {
        socket.write(encodeLine({ id: -1, ok: false, error: "Malformed request line" }));
        continue;
      }
      void handle(request).then((response) => {
        if (!socket.destroyed) socket.write(encodeLine(response));
      });
    }
  });
});

async function stop(reason: string): Promise<never> {
  console.error(`[claude-design daemon] stopping: ${reason}`);
  await browser.shutdown().catch((error: unknown) => console.error(`[claude-design daemon] browser shutdown failed: ${String(error)}`));
  server.close();
  rmSync(SOCKET_PATH, { force: true });
  process.exit(0);
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
chmodSync(STATE_DIR, 0o700);
if (await socketInUse()) {
  console.error("[claude-design daemon] another daemon is already serving the socket");
  process.exit(0);
}
rmSync(SOCKET_PATH, { force: true });
server.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o600);
  console.error(`[claude-design daemon] pid ${process.pid} listening on ${SOCKET_PATH}`);
});
setInterval(() => {
  const idleFor = Date.now() - lastActivity;
  if (inFlight === 0 && idleFor > IDLE_MS) void stop("idle");
  else if (inFlight === 0 && idleFor > BROWSER_IDLE_MS && browser.running) {
    designs.reset();
    void browser.shutdown().catch((error: unknown) => console.error(`[claude-design daemon] browser shutdown failed: ${String(error)}`));
  }
}, 60_000);
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
