import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Page } from "playwright-core";
import { type BrowserHost, profileHolder } from "./browser.ts";
import {
  type Api,
  ClaudeHttpError,
  type Manifest,
  NotLoggedInError,
  LOGIN_HELP,
  classifyTurn,
  EMPTY_SIGNATURE,
  frame,
  getManifest,
  getManifestOrNull,
  getSession,
  latestAssistantText,
  parseDesignLocation,
  readEvents,
  realPromptCount,
  signature,
} from "./claude.ts";
import { downloadDesign, previewCandidates } from "./files.ts";
import { CACHE_DIR, DESIGN_HOME, designUrl } from "./paths.ts";
import { readIndex, updateEntry } from "./store.ts";

const NEW_DESIGN_LABELS = ["Design, New", "디자인, 신규"];
const MAX_PREVIEW_HEIGHT = 5000;
const MAX_PREVIEW_WIDTH = 4096;
const MAX_IMAGE_BASE64 = 4_500_000;

async function pollFor<T>(read: () => Promise<T | null>, timeoutMs: number, onTimeout: () => string, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(onTimeout());
    await Bun.sleep(intervalMs);
  }
}

const SETTLE_SCRIPT = `new Promise((resolve) => {
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  fonts.then(() => {
    let last = performance.getEntriesByType("resource").length;
    let stable = 0;
    const timer = setInterval(() => {
      const count = performance.getEntriesByType("resource").length;
      stable = count === last ? stable + 1 : 0;
      last = count;
      if (stable >= 3) { clearInterval(timer); resolve(true); }
    }, 250);
    setTimeout(() => { clearInterval(timer); resolve(false); }, 8000);
  });
})`;

const TWO_FRAMES = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

async function typeText(page: Page, text: string): Promise<void> {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    if (line) await page.keyboard.insertText(line);
  }
}

export type PreviewImage = {
  file: string;
  width: number;
  height: number;
  truncated: boolean;
  mimeType: "image/png" | "image/jpeg";
  data: string;
};

export class Designs {
  #browser: BrowserHost;
  #api: Api | null = null;
  #designType: string | null = null;

  constructor(browser: BrowserHost) {
    this.#browser = browser;
  }

  reset(): void {
    this.#api = null;
  }

  async #ensureApi(): Promise<Api> {
    if (this.#api) return this.#api;
    const page = await this.#browser.view("rpc");
    await page.goto(DESIGN_HOME, { waitUntil: "domcontentloaded" });
    let lastTitle = "";
    const state = await pollFor(
      async () => {
        const current = (await page.evaluate(
          `({ path: location.pathname, title: document.title, org: (document.cookie.match(/lastActiveOrg=([^;]+)/) || [])[1] || null })`,
        )) as { path: string; title: string; org: string | null };
        lastTitle = current.title;
        if (/just a moment|checking your browser/i.test(current.title)) return null;
        if (current.path.startsWith("/login") || current.path.startsWith("/logout")) return { org: null };
        return current.org ? { org: decodeURIComponent(current.org) } : null;
      },
      20_000,
      () => `claude.ai did not finish loading (last page title: "${lastTitle}"). A Cloudflare check may be blocking the headless browser.`,
    );
    if (!state.org) throw new NotLoggedInError(LOGIN_HELP);
    const api = { page, org: state.org };
    await frame(api, "GET", "/api/frame/types");
    this.#api = api;
    return api;
  }

  async #designTypeSlug(api: Api): Promise<string> {
    if (this.#designType) return this.#designType;
    const response = (await frame(api, "GET", "/api/frame/types")) as unknown;
    const types = Array.isArray(response) ? response : (response as { types?: unknown[] } | null)?.types;
    const design = (types as Array<{ title?: string; slug?: string }> | undefined)?.find((type) => type.title === "Design");
    if (!design?.slug) throw new Error("claude.ai did not list a Design artifact type for this account");
    this.#designType = design.slug;
    return design.slug;
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.#browser.running && (await profileHolder()).kind === "login-window") {
      return { loggedIn: false, loginWindowOpen: true, hint: "Finish signing in, then quit that Chrome window with Cmd+Q." };
    }
    try {
      const api = await this.#ensureApi();
      return { loggedIn: true, org: api.org, designType: await this.#designTypeSlug(api) };
    } catch (error) {
      if (error instanceof NotLoggedInError) return { loggedIn: false, hint: LOGIN_HELP };
      throw error;
    }
  }

  async login(): Promise<Record<string, unknown>> {
    this.reset();
    const result = await this.#browser.openLoginWindow();
    return {
      window: result,
      instructions: "A Chrome window with the design profile is open on claude.ai. Sign in there, then quit it with Cmd+Q. After that, design_status reports loggedIn: true.",
    };
  }

  async list(params: { limit?: number }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 100);
    const slug = await this.#designTypeSlug(api);
    const response = (await frame(api, "GET", `/api/frame/artifacts?rel=mine&type=${encodeURIComponent(slug)}&limit=${limit}`)) as {
      artifacts?: Array<{ id: string; title: string; updated_at?: string; last_edit?: { cowork?: string[] } }>;
    };
    if (!Array.isArray(response?.artifacts)) throw new TypeError("Unexpected artifacts listing shape");
    const index = readIndex();
    return {
      designs: response.artifacts.map((item) => {
        const sessionId = item.last_edit?.cowork?.[0] ?? index[item.id]?.sessionId ?? null;
        return { projectId: item.id, name: item.title, updatedAt: item.updated_at ?? null, sessionId, url: designUrl(item.id, sessionId) };
      }),
    };
  }

  async #promptCount(api: Api, sessionId: string): Promise<number> {
    try {
      return realPromptCount(await readEvents(api, sessionId));
    } catch (error) {
      if (error instanceof ClaudeHttpError && error.status === 404) return 0;
      throw error;
    }
  }

  async #submit(api: Api, page: Page, projectId: string, sessionId: string, text: string): Promise<void> {
    await pollFor(
      async () => ((await page.evaluate("!!document.querySelector('[data-testid=chat-input]')")) ? true : null),
      30_000,
      () => "The design composer input did not appear",
    );
    const manifest = await getManifestOrNull(api, projectId);
    const baseline = manifest ? signature(manifest.files) : EMPTY_SIGNATURE;
    const before = await this.#promptCount(api, sessionId);
    const focused = await page.evaluate(`(() => {
      const input = document.querySelector('[data-testid=chat-input]');
      if (!input) return false;
      input.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      return true;
    })()`);
    if (!focused) throw new Error("The design composer input disappeared before typing");
    await typeText(page, text);
    const clicked = await page.evaluate(`(() => {
      const button = document.querySelector('[data-testid=chat-input-send]');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      button.click();
      return true;
    })()`);
    if (!clicked) await page.keyboard.press("Enter");
    await pollFor(
      async () => ((await this.#promptCount(api, sessionId)) > before ? true : null),
      45_000,
      () => "claude.ai did not record the prompt; open the design URL to check the composer",
      1000,
    );
    updateEntry(projectId, { sessionId, baseline, submittedAt: Date.now() });
  }

  async create(params: { prompt: string; name?: string }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const page = await this.#browser.view("composer");
    try {
      await page.goto(DESIGN_HOME, { waitUntil: "domcontentloaded" });
      await pollFor(
        async () =>
          (await page.evaluate(`((labels) => {
            const button = [...document.querySelectorAll('button')].find((element) =>
              labels.includes(element.getAttribute('aria-label') || '') && element.getClientRects().length && !element.disabled);
            if (!button) return false;
            button.click();
            return true;
          })(${JSON.stringify(NEW_DESIGN_LABELS)})`))
            ? true
            : null,
        30_000,
        () => `Could not find the new Design card (looked for aria-label ${NEW_DESIGN_LABELS.join(" / ")})`,
      );
      const location = await pollFor(
        async () => parseDesignLocation(String(await page.evaluate("location.href"))),
        30_000,
        () => "claude.ai did not open a new Design session",
      );
      const name = (params.name ?? params.prompt).replace(/\s+/g, " ").trim().slice(0, 80);
      let titleWarning: string | undefined;
      try {
        await frame(api, "POST", `/api/frame/retitle/${encodeURIComponent(location.projectId)}`, { title: name });
      } catch (error) {
        titleWarning = `Could not rename the design: ${error instanceof Error ? error.message : String(error)}`;
      }
      updateEntry(location.projectId, { name, sessionId: location.sessionId });
      await this.#submit(api, page, location.projectId, location.sessionId, params.prompt);
      return {
        projectId: location.projectId,
        sessionId: location.sessionId,
        name,
        url: designUrl(location.projectId, location.sessionId),
        status: "generating",
        ...(titleWarning ? { warning: titleWarning } : {}),
      };
    } finally {
      await this.#browser.close("composer");
    }
  }

  async #sessionFor(api: Api, projectId: string): Promise<string> {
    const indexed = readIndex()[projectId]?.sessionId;
    if (indexed) return indexed;
    const listing = (await this.list({ limit: 100 })) as { designs: Array<{ projectId: string; sessionId: string | null }> };
    const sessionId = listing.designs.find((design) => design.projectId === projectId)?.sessionId;
    if (!sessionId) throw new Error(`No Cowork session is known for design ${projectId}`);
    updateEntry(projectId, { sessionId });
    void api;
    return sessionId;
  }

  async reply(params: { projectId: string; message: string }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const sessionId = await this.#sessionFor(api, params.projectId);
    const session = await getSession(api, sessionId);
    if (session.worker_status && session.worker_status !== "idle") {
      throw new Error(`Claude Design is still working on ${params.projectId}; call design_wait first`);
    }
    const page = await this.#browser.view("composer");
    try {
      await page.goto(designUrl(params.projectId, sessionId), { waitUntil: "domcontentloaded" });
      await this.#submit(api, page, params.projectId, sessionId, params.message);
    } finally {
      await this.#browser.close("composer");
    }
    return { projectId: params.projectId, sessionId, url: designUrl(params.projectId, sessionId), status: "generating" };
  }

  async check(params: { projectId: string }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const sessionId = await this.#sessionFor(api, params.projectId);
    const [session, manifest] = await Promise.all([getSession(api, sessionId), getManifestOrNull(api, params.projectId)]);
    const entry = readIndex()[params.projectId];
    const turn = classifyTurn({
      session,
      signature: manifest ? signature(manifest.files) : EMPTY_SIGNATURE,
      baseline: entry?.baseline ?? null,
      submittedAt: entry?.submittedAt ?? null,
      now: Date.now(),
    });
    const settled = turn.status !== "generating" && turn.status !== "stalled";
    const reply = settled ? latestAssistantText(await readEvents(api, sessionId)) : null;
    return {
      projectId: params.projectId,
      sessionId,
      url: designUrl(params.projectId, sessionId),
      ...turn,
      ...(reply ? { claudeReply: reply.slice(0, 4000) } : {}),
      files: manifest ? manifest.files.filter((file) => file.path.startsWith("project/")).map((file) => file.path.slice(8)) : [],
    };
  }

  async #cachedCopy(projectId: string, manifest: Manifest): Promise<{ dir: string; files: string[]; errors: unknown[] }> {
    const dir = join(CACHE_DIR, projectId, signature(manifest.files).slice(0, 16));
    const marker = join(dir, ".download.json");
    if (existsSync(marker)) return { dir, ...(JSON.parse(await readFile(marker, "utf8")) as { files: string[]; errors: unknown[] }) };
    const result = await downloadDesign(projectId, manifest, dir);
    await writeFile(marker, JSON.stringify(result));
    return { dir, ...result };
  }

  async preview(params: { projectId: string; file?: string; width?: number; maxImages?: number }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const manifest = await getManifest(api, params.projectId);
    const copy = await this.#cachedCopy(params.projectId, manifest);
    const candidates = params.file ? [params.file.replace(/^project\//, "")] : previewCandidates(copy.files);
    if (!candidates.length) throw new Error(`Design ${params.projectId} has no HTML file to preview yet`);
    const maxImages = Math.min(Math.max(Math.trunc(params.maxImages ?? 4), 1), 8);
    const width = Math.min(Math.max(Math.trunc(params.width ?? 1440), 320), MAX_PREVIEW_WIDTH);
    const root = resolve(copy.dir);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const target = resolve(root, decodeURIComponent(new URL(request.url).pathname.slice(1)));
        if (!target.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
        const file = Bun.file(target);
        return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
      },
    });
    const images: PreviewImage[] = [];
    try {
      for (const rel of candidates.slice(0, maxImages)) images.push(await this.#render(server.port ?? 0, rel, width));
    } finally {
      server.stop(true);
      await this.#browser.close("preview");
    }
    return {
      projectId: params.projectId,
      title: manifest.title,
      images,
      notRendered: candidates.slice(maxImages),
      downloadErrors: copy.errors,
    };
  }

  async #render(port: number, rel: string, width: number): Promise<PreviewImage> {
    const page = await this.#browser.view("preview");
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/${rel.split("/").map(encodeURIComponent).join("/")}`, { waitUntil: "load" });
    await page.evaluate(SETTLE_SCRIPT);
    const size = (await page.evaluate(
      "({ w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })",
    )) as { w: number; h: number };
    const finalWidth = Math.min(Math.max(size.w, width), MAX_PREVIEW_WIDTH);
    const finalHeight = Math.min(Math.max(size.h, 300), MAX_PREVIEW_HEIGHT);
    await page.setViewportSize({ width: finalWidth, height: finalHeight });
    await page.evaluate(TWO_FRAMES);
    let data = (await page.screenshot({ type: "png" })).toString("base64");
    let mimeType: PreviewImage["mimeType"] = "image/png";
    if (data.length > MAX_IMAGE_BASE64) {
      data = (await page.screenshot({ type: "jpeg", quality: 80 })).toString("base64");
      mimeType = "image/jpeg";
    }
    return { file: rel, width: finalWidth, height: finalHeight, truncated: size.h > finalHeight, mimeType, data };
  }

  async pull(params: { projectId: string; dir: string }): Promise<Record<string, unknown>> {
    const api = await this.#ensureApi();
    const manifest = await getManifest(api, params.projectId);
    const result = await downloadDesign(params.projectId, manifest, params.dir);
    return { projectId: params.projectId, title: manifest.title, dir: resolve(params.dir), ...result };
  }
}
