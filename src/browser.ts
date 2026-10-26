import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type Page, chromium } from "playwright-core";
import { CHROME_PATH, LOGIN_URL, PROFILE_DIR } from "./paths.ts";

export class LoginWindowOpenError extends Error {
  override name = "LoginWindowOpenError";
  constructor() {
    super("The design-profile Chrome login window is still open. Finish signing in, then quit it with Cmd+Q and retry.");
  }
}

type ProfileHolder = { kind: "none" } | { kind: "login-window" | "automation"; pid: number };

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
  return { kind: args.includes("--remote-debugging-pipe") ? "automation" : "login-window", pid };
}

async function waitForProfileRelease(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await profileHolder()).kind !== "none") {
    if (Date.now() > deadline) throw new Error("Chrome did not release the design profile in time");
    await Bun.sleep(250);
  }
}

export class BrowserHost {
  #context: BrowserContext | null = null;
  #pages = new Map<string, Page>();

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    const holder = await profileHolder();
    if (holder.kind === "login-window") throw new LoginWindowOpenError();
    if (holder.kind === "automation") {
      process.kill(holder.pid, "SIGTERM");
      await waitForProfileRelease(10_000);
    }
    // Headless Chrome stops at claude.ai's Cloudflare check, so the design profile runs as a normal window.
    // Playwright's mock keychain cannot decrypt the cookies the login window stored, which signs the profile out.
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: CHROME_PATH,
      headless: false,
      ignoreDefaultArgs: ["--use-mock-keychain"],
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });
    context.setDefaultNavigationTimeout(60_000);
    context.once("close", () => {
      if (this.#context !== context) return;
      this.#context = null;
      this.#pages.clear();
    });
    this.#context = context;
    return context;
  }

  async view(name: string): Promise<Page> {
    const existing = this.#pages.get(name);
    if (existing && !existing.isClosed()) return existing;
    const page = await (await this.#ensureContext()).newPage();
    this.#pages.set(name, page);
    return page;
  }

  async close(name: string): Promise<void> {
    const page = this.#pages.get(name);
    this.#pages.delete(name);
    await page?.close();
  }

  async shutdown(): Promise<void> {
    const context = this.#context;
    this.#context = null;
    this.#pages.clear();
    await context?.close();
  }

  get running(): boolean {
    return this.#context !== null;
  }

  async openLoginWindow(): Promise<"opened" | "already-open"> {
    await this.shutdown();
    const holder = await profileHolder();
    if (holder.kind === "login-window") return "already-open";
    if (holder.kind === "automation") process.kill(holder.pid, "SIGTERM");
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
