import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { LOG_PATH, SOCKET_PATH, STATE_DIR } from "./paths.ts";
import { type DaemonResponse, DaemonError, LineDecoder, encodeLine } from "./protocol.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function spawnDaemon(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const log = openSync(LOG_PATH, "a", 0o600);
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
}

async function connectOrSpawn(): Promise<net.Socket> {
  try {
    return await connect();
  } catch {
    spawnDaemon();
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return await connect();
    } catch {
      if (Date.now() > deadline) throw new DaemonError(`Could not start the design daemon; see ${LOG_PATH}`);
      await Bun.sleep(200);
    }
  }
}

let nextId = 1;

export async function callDaemon<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 240_000,
): Promise<T> {
  const socket = await connectOrSpawn();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const decoder = new LineDecoder();
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => reject(new DaemonError(`The design daemon did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const response = JSON.parse(line) as DaemonResponse;
        if (response.id !== id) continue;
        finish(() => (response.ok ? resolve(response.result as T) : reject(new DaemonError(response.error))));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => finish(() => reject(new DaemonError(`The design daemon closed the connection during ${method}`))));
    socket.write(encodeLine({ id, method, params }));
  });
}
