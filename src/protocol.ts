export type DaemonRequest = { id: number; method: string; params: Record<string, unknown> };
export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export function encodeLine(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineDecoder {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  }
}

export class DaemonError extends Error {
  override name = "DaemonError";
}
