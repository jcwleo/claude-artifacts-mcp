import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INDEX_PATH } from "./paths.ts";

export type DesignEntry = {
  name?: string;
  sessionId?: string;
  baseline?: string;
  submittedAt?: number;
};

type Index = Record<string, DesignEntry>;

export function readIndex(path = INDEX_PATH): Index {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Index) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function updateEntry(projectId: string, patch: DesignEntry, path = INDEX_PATH): DesignEntry {
  const index = readIndex(path);
  const entry = { ...index[projectId], ...patch };
  index[projectId] = entry;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return entry;
}
