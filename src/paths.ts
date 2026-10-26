import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.CLAUDE_DESIGN_STATE_DIR ?? join(homedir(), ".claude-design-mcp");
export const PROFILE_DIR = join(STATE_DIR, "chrome-profile");
export const SOCKET_PATH = join(STATE_DIR, "daemon.sock");
export const INDEX_PATH = join(STATE_DIR, "designs.json");
export const CACHE_DIR = join(STATE_DIR, "cache");
export const LOG_PATH = join(STATE_DIR, "daemon.log");
export const CHROME_PATH =
  process.env.CLAUDE_DESIGN_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const CLAUDE_ORIGIN = "https://claude.ai";
export const DESIGN_HOME = `${CLAUDE_ORIGIN}/artifacts/design`;
export const LOGIN_URL = `${CLAUDE_ORIGIN}/login`;

export function designUrl(projectId: string, sessionId: string | null): string {
  const artifact = encodeURIComponent(projectId);
  return sessionId
    ? `${CLAUDE_ORIGIN}/cowork/${encodeURIComponent(sessionId)}?artifact=${artifact}`
    : `${CLAUDE_ORIGIN}/code/artifact/${artifact}`;
}
