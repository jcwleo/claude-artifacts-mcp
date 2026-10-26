import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { CHROME_PATH, LOGIN_URL, PROFILE_DIR } from "./paths.ts";

export class LoginWindowOpenError extends Error {
  override name = "LoginWindowOpenError";
  constructor() {
    super("The design-profile Chrome login window is still open. Finish signing in, then quit it with Cmd+Q and retry.");
  }
}

type ProfileHolder = { kind: "none" } | { kind: "login-window" | "headless"; pid: number };

function lockPid(): number | null {
  try {
    const pid = Number(readlinkSync(join(PROFILE_DIR, "SingletonLock")).split("-").at(-1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function commandLine(pid: number): Promise<string> {
  const child = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim();
}

export async function profileHolder(): Promise<ProfileHolder> {
  const pid = lockPid();
  if (pid === null || !isAlive(pid)) return { kind: "none" };
  const args = await commandLine(pid);
  if (!args.includes(PROFILE_DIR)) return { kind: "none" };
  return { kind: args.includes("--headless") ? "headless" : "login-window", pid };
}

async function waitForProfileRelease(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await profileHolder()).kind !== "none") {
    if (Date.now() > deadline) throw new Error("Chrome did not release the design profile in time");
    await Bun.sleep(250);
  }
}

export class BrowserHost {
  #views = new Map<string, Bun.WebView>();
  #chromeRunning = false;

  async view(name: string): Promise<Bun.WebView> {
    const existing = this.#views.get(name);
    if (existing) return existing;
    if (!this.#chromeRunning) {
      const holder = await profileHolder();
      if (holder.kind === "login-window") throw new LoginWindowOpenError();
      if (holder.kind === "headless") {
        process.kill(holder.pid, "SIGTERM");
        await waitForProfileRelease(10_000);
      }
    }
    const view = new Bun.WebView({
      width: 1440,
      height: 900,
      backend: { type: "chrome", path: CHROME_PATH, argv: ["--lang=en-US"] },
      dataStore: { directory: PROFILE_DIR },
    });
    this.#chromeRunning = true;
    this.#views.set(name, view);
    return view;
  }

  close(name: string): void {
    this.#views.get(name)?.close();
    this.#views.delete(name);
  }

  shutdown(): void {
    for (const view of this.#views.values()) view.close();
    this.#views.clear();
    if (this.#chromeRunning) Bun.WebView.closeAll();
    this.#chromeRunning = false;
  }

  get running(): boolean {
    return this.#chromeRunning;
  }

  async openLoginWindow(): Promise<"opened" | "already-open"> {
    this.shutdown();
    const holder = await profileHolder();
    if (holder.kind === "login-window") return "already-open";
    if (holder.kind === "headless") process.kill(holder.pid, "SIGTERM");
    await waitForProfileRelease(10_000);
    const appBundle = CHROME_PATH.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    const child = Bun.spawn(
      ["open", "-na", appBundle, "--args", `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", LOGIN_URL],
      { stdout: "ignore", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Could not open Chrome: ${(await new Response(child.stderr).text()).trim()}`);
    return "opened";
  }
}
