import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { type Manifest, frameFileUrl, projectFiles } from "./claude.ts";

export const RUNTIME_PATH = "artifact-type/dc-runtime.js";
const TEXT_FILE = /\.(?:html?|css|js|mjs|jsx|json|svg)$/i;
const BLOB_REFERENCE = /\/_blob\/([A-Za-z0-9_-]+)/g;

export function safeRelPath(rel: string): string {
  const normalized = posix.normalize(rel.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Refusing unsafe artifact path: ${rel}`);
  }
  return normalized.normalize("NFC");
}

export function blobIds(text: string): string[] {
  return [...new Set([...text.matchAll(BLOB_REFERENCE)].map((match) => match[1] as string))];
}

export function rewriteBlobRefs(rel: string, text: string, available: ReadonlySet<string>): string {
  return text.replace(BLOB_REFERENCE, (original, id: string) => {
    const blobPath = `_blob/${id}`;
    if (!available.has(blobPath)) return original;
    const relative = posix.relative(posix.dirname(rel), blobPath);
    return relative.startsWith(".") ? relative : `./${relative}`;
  });
}

export function supportPathsFor(rels: readonly string[]): string[] {
  return [
    ...new Set(rels.filter((rel) => /\.dc\.html$/i.test(rel)).map((rel) => posix.join(posix.dirname(rel), "support.js"))),
  ];
}

export function previewCandidates(rels: readonly string[]): string[] {
  const html = rels.filter((rel) => /\.html?$/i.test(rel));
  const designs = html.filter((rel) => /\.dc\.html$/i.test(rel));
  if (designs.length) return designs;
  const index = html.filter((rel) => /(^|\/)index\.html?$/i.test(rel));
  return index.length ? index : html;
}

type Fetcher = (url: string) => Promise<Response>;

async function fetchBytes(url: string, fetcher: Fetcher): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${new URL(url).pathname}`);
  return new Uint8Array(await response.arrayBuffer());
}

export type DownloadResult = { files: string[]; errors: Array<{ path: string; error: string }> };

export async function downloadDesign(
  projectId: string,
  manifest: Manifest,
  destDir: string,
  fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) }),
): Promise<DownloadResult> {
  const root = resolve(destDir);
  const assets = new Map<string, Uint8Array>();
  const errors: DownloadResult["errors"] = [];
  const redact = (message: string) => message.replaceAll(manifest.assetToken, "[redacted]");

  const download = async (rel: string, remotePath: string) => {
    try {
      assets.set(rel, await fetchBytes(frameFileUrl(projectId, manifest.ver, remotePath, manifest.assetToken), fetcher));
    } catch (error) {
      errors.push({ path: rel, error: redact(error instanceof Error ? error.message : String(error)) });
    }
  };

  const files = projectFiles(manifest.files).map((file) => ({ ...file, rel: safeRelPath(file.rel) }));
  await Promise.all(files.map((file) => download(file.rel, file.path)));

  const supportPaths = supportPathsFor(files.map((file) => file.rel));
  if (supportPaths.length) {
    const runtime = manifest.files.find((file) => file.path === RUNTIME_PATH);
    if (!runtime) {
      errors.push({ path: "support.js", error: `${RUNTIME_PATH} is not in the manifest` });
    } else {
      try {
        const bytes = await fetchBytes(frameFileUrl(projectId, manifest.ver, runtime.path, manifest.assetToken), fetcher);
        for (const rel of supportPaths) assets.set(rel, bytes);
      } catch (error) {
        errors.push({ path: "support.js", error: redact(error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  const decoder = new TextDecoder();
  const referenced = new Set<string>();
  for (const [rel, bytes] of assets) {
    if (TEXT_FILE.test(rel)) for (const id of blobIds(decoder.decode(bytes))) referenced.add(id);
  }
  await Promise.all([...referenced].map((id) => download(`_blob/${id}`, `_blob/${id}`)));
  const blobs = new Set([...assets.keys()].filter((rel) => rel.startsWith("_blob/")));

  const encoder = new TextEncoder();
  const written: string[] = [];
  for (const [rel, bytes] of assets) {
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Refusing to write outside ${root}: ${rel}`);
    const content =
      TEXT_FILE.test(rel) && !rel.startsWith("_blob/") ? encoder.encode(rewriteBlobRefs(rel, decoder.decode(bytes), blobs)) : bytes;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.partial`;
    await writeFile(temporary, content);
    await rename(temporary, target);
    written.push(rel);
  }
  return { files: written.sort(), errors };
}
