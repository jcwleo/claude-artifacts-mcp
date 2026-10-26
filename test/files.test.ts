import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../src/claude.ts";
import {
  RUNTIME_PATH,
  blobIds,
  designFolderName,
  downloadDesign,
  previewCandidates,
  rewriteBlobRefs,
  safeRelPath,
  supportPathsFor,
} from "../src/files.ts";
import { LineDecoder } from "../src/protocol.ts";

describe("path helpers", () => {
  test("safeRelPath normalizes and refuses traversal", () => {
    expect(safeRelPath("a/./b/../c.html")).toBe("a/c.html");
    expect(safeRelPath("/root.html")).toBe("root.html");
    expect(() => safeRelPath("../escape.html")).toThrow();
    expect(() => safeRelPath("a/../../escape.html")).toThrow();
  });

  test("designFolderName slugs the title, keeps the id prefix and never escapes the base dir", () => {
    const id = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    expect(designFolderName("MCP PoC test - reading dashboard", id)).toBe("mcp-poc-test-reading-dashboard-a1b2c3d4");
    expect(designFolderName("독서 대시보드!", id)).toBe("독서-대시보드-a1b2c3d4");
    expect(designFolderName("../..", id)).toBe("a1b2c3d4");
    expect(designFolderName("", id)).toBe("a1b2c3d4");
  });

  test("support.js goes next to every .dc.html directory once", () => {
    expect(supportPathsFor(["Main.dc.html", "boards/A.dc.html", "boards/B.dc.html", "style.css"])).toEqual([
      "support.js",
      "boards/support.js",
    ]);
  });

  test("previewCandidates prefers artboards, then index pages, then any html", () => {
    expect(previewCandidates(["index.html", "Main.dc.html", "x.css"])).toEqual(["Main.dc.html"]);
    expect(previewCandidates(["about.html", "site/index.html"])).toEqual(["site/index.html"]);
    expect(previewCandidates(["about.html", "x.css"])).toEqual(["about.html"]);
  });

  test("blob references become relative paths only when the blob was downloaded", () => {
    const html = '<img src="/_blob/abc_1"><img src="/_blob/missing">';
    expect(blobIds(html)).toEqual(["abc_1", "missing"]);
    expect(rewriteBlobRefs("boards/A.dc.html", html, new Set(["_blob/abc_1"]))).toBe(
      '<img src="../_blob/abc_1"><img src="/_blob/missing">',
    );
  });
});

describe("downloadDesign", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("writes project files, the runtime as support.js and referenced blobs, and redacts the token", async () => {
    dir = await mkdtemp(join(tmpdir(), "design-pull-"));
    const manifest: Manifest = {
      ver: "v7",
      assetToken: "secret-token",
      title: "Dashboard",
      updatedAt: "2026-10-26T00:00:00.000Z",
      files: [
        { path: "project/Main.dc.html", sha256: "1" },
        { path: "project/broken.css", sha256: "2" },
        { path: RUNTIME_PATH, sha256: "3" },
      ],
    };
    const bodies: Record<string, string> = {
      "/_f/v7/project/Main.dc.html": '<script src="./support.js"></script><img src="/_blob/img1">',
      "/_f/v7/artifact-type/dc-runtime.js": "window.runtime = true;",
      "/_f/v7/_blob/img1": "PNGDATA",
    };
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      const body = bodies[new URL(url).pathname];
      return body === undefined ? new Response(`missing secret-token`, { status: 404 }) : new Response(body);
    };

    const result = await downloadDesign("proj", manifest, dir, fetcher);

    expect(result.files).toEqual(["Main.dc.html", "_blob/img1", "support.js"]);
    expect(result.errors).toEqual([{ path: "broken.css", error: "HTTP 404 /_f/v7/project/broken.css" }]);
    expect(await readFile(join(dir, "Main.dc.html"), "utf8")).toBe('<script src="./support.js"></script><img src="./_blob/img1">');
    expect(await readFile(join(dir, "support.js"), "utf8")).toBe("window.runtime = true;");
    expect(requested.every((url) => url.startsWith("https://proj.frame.claudeusercontent.com/_f/v7/"))).toBe(true);
  });
});

describe("LineDecoder", () => {
  test("splits newline-delimited messages across chunk boundaries", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(':2}\n\n')).toEqual(['{"b":2}']);
  });
});
