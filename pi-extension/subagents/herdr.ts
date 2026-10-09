/**
 * herdr backend for pi-interactive-subagents.
 *
 * All herdr CLI knowledge lives here; `cmux.ts` stays the dispatcher. This
 * module never imports `cmux.ts` (no cycle).
 *
 * ── Design (why the launch is NOT `herdr agent start`) ──────────────────────
 *
 * Subagents are launched as *argv-backed plugin panes*:
 *
 *   pane split --no-focus  →  pane run "bash <launch-script>"  →  sentinel
 *
 * The launch script is the plugin's own command string (env prefix, `--session`,
 * `-e subagent-done.ts`, task/skill args) written by `sendLongCommand`, and it
 * ends with `; echo '__SUBAGENT_DONE_'$?'__'`.
 *
 * `herdr agent start --kind pi --pane <id> -- <args>` cannot carry that
 * contract: it runs herdr's canonical `pi` executable with argv only, so there
 * is no env prefix (`PI_SUBAGENT_*`), no `bash` wrapper and therefore no exit
 * sentinel — which is what `pollForExit`'s crash detection and the
 * `subagent_done`/`.exit` sidecar flow rely on. Env could be pushed into
 * `pane split --env`, but the shell wrapper cannot.
 *
 * So the agent *facade* (`agent read` / `agent send-keys` / `agent wait` /
 * `agent start` / `agent prompt`) is used where herdr already recognises the
 * pane as an agent — reads and interrupts prefer it, with a pane-level
 * fallback — while delivery stays `pane run`, which is the atomic submit
 * primitive herdr documents for panes that are not a recognised agent.
 *
 * ── Version floor ───────────────────────────────────────────────────────────
 *
 * MINIMUM herdr: 0.9.0 (0.9.0 made `agent prompt` atomic and tightened `--wait`
 * to require observed working/blocked activity). See
 * `Doc/herdr-plugin-strategy.md` §4.1. The floor is reported by
 * `meetsHerdrFloor()` / surfaced as a warning — it never blocks a spawn,
 * because the launch path above does not depend on 0.9.0-only behaviour.
 *
 * ── Safety invariants ───────────────────────────────────────────────────────
 *
 * 1. Never stop the herdr server. This module never emits `server stop`,
 *    `tab close` or `workspace close` (asserted by unit tests).
 * 2. Never close a foreign pane: `closeHerdrSurface` refuses the parent pane
 *    (`HERDR_PANE_ID`). Only surfaces created for a subagent are ever closed.
 * 3. Never swallow a genuine failure: unknown herdr error codes propagate as
 *    `HerdrError`. Only documented, idempotent cases are tolerated
 *    (`pane_not_found` on close) and safe fallbacks are bounded to one try.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Minimum supported herdr version.
 *
 * SINGLE SOURCE OF TRUTH for the floor. velpari's doctor (herdr integration
 * initiative Phase 3) mirrors this value as `0.9.0`; if one side moves, move
 * both. Never inline another version literal in this module.
 */
export const HERDR_MIN_VERSION = "0.9.0";

/** Default timeout for `agent start` readiness (herdr's own default is 30s). */
export const HERDR_AGENT_START_TIMEOUT_MS = 30_000;

/** Default timeout for `agent wait` / the completion accelerator. */
export const HERDR_AGENT_WAIT_TIMEOUT_MS = 30_000;

/** Default timeout for `agent prompt --wait` (a full agent turn can be long). */
export const HERDR_AGENT_PROMPT_TIMEOUT_MS = 300_000;

/**
 * Preferred read source. `recent-unwrapped` returns the scrollback with wrapped
 * lines unwrapped — stable for sentinel detection and for long full-screen
 * agent output. `recent` is the fallback for builds without the newer source.
 */
export const HERDR_READ_SOURCE_PREFERRED = "recent-unwrapped";
export const HERDR_READ_SOURCE_FALLBACK = "recent";

/** Key name herdr documents for the Escape key. */
export const HERDR_ESC_KEY = "esc";

export type HerdrSplitDirection = "left" | "right" | "up" | "down";

/** Herdr only supports right/down splits; left/up are mapped to their leaders. */
export function herdrSplitDirection(direction: HerdrSplitDirection): "right" | "down" {
  return direction === "left" || direction === "right" ? "right" : "down";
}

// ── Command availability ────────────────────────────────────────────────────

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Pure env sniff. herdr injects `HERDR_ENV=1` (plus `HERDR_PANE_ID`,
 * `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`) into panes it
 * manages. velpari detects the same two signals, and herdr is the LAST
 * auto-detect branch so a multiplexer running inside herdr still wins.
 */
export function herdrEnvDetected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" || !!env.HERDR_PANE_ID;
}

/** True when we are inside a herdr pane AND the CLI is installed. */
export function isHerdrAvailable(): boolean {
  return herdrEnvDetected() && hasCommand("herdr");
}

// ── Version helpers ─────────────────────────────────────────────────────────

/** Parse `herdr 0.9.3` (or a bare `0.9.3`) into numeric parts. Pure. */
export function parseHerdrVersion(text: string | undefined | null): [number, number, number] | null {
  if (!text) return null;
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric (not lexical) version comparison. Negative = a < b. Pure. */
export function compareHerdrVersions(a: string, b: string): number {
  const left = parseHerdrVersion(a);
  const right = parseHerdrVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** `herdr --version`, best-effort — returns e.g. `0.9.3` or null. */
export function getHerdrVersion(): string | null {
  try {
    const raw = herdrExec(["--version"]).trim();
    const parsed = parseHerdrVersion(raw);
    return parsed ? parsed.join(".") : null;
  } catch {
    return null;
  }
}

/**
 * Whether the installed herdr meets `HERDR_MIN_VERSION`.
 *
 * Informational only — callers warn, they do not block. Unknown versions are
 * treated as meeting the floor so an unparseable output never disables herdr.
 */
export function meetsHerdrFloor(version: string | null = getHerdrVersion()): boolean {
  if (!version) return true;
  return compareHerdrVersions(version, HERDR_MIN_VERSION) >= 0;
}

// ── Error handling ──────────────────────────────────────────────────────────

/**
 * herdr CLI failures print a JSON error on stderr and exit non-zero:
 *   {"error":{"code":"pane_not_found","message":"pane wZ:p99 not found"},"id":"cli:pane:get"}
 */
export function parseHerdrError(
  stderr: string | undefined,
): { code: string; message: string } | null {
  if (!stderr) return null;
  const start = stderr.indexOf("{");
  if (start === -1) return null;
  const parsed = parseHerdrJson(stderr.slice(start));
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!error || typeof error.code !== "string" || !error.code) return null;
  return {
    code: error.code,
    message: typeof error.message === "string" ? error.message : "",
  };
}

/** Actionable hint for the error codes callers are expected to act on. */
export function herdrErrorHint(code: string): string | null {
  if (code === "server_not_running") {
    return "herdr server is not reachable — start it with `herdr`, or point HERDR_SOCKET_PATH at a running server.";
  }
  return null;
}

export class HerdrError extends Error {
  readonly code: string;
  readonly args: string[];

  constructor(code: string, message: string, args: string[]) {
    const hint = herdrErrorHint(code);
    super(
      `herdr ${args.join(" ")} failed (${code}): ${message || "no message"}${hint ? `\n${hint}` : ""}`,
    );
    this.name = "HerdrError";
    this.code = code;
    this.args = args;
  }
}

export function isHerdrErrorCode(error: unknown, code: string): boolean {
  return error instanceof HerdrError && error.code === code;
}

function toHerdrError(error: unknown, args: string[]): HerdrError {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text =
    typeof stderr === "string"
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString("utf8")
        : undefined;
  const parsed = parseHerdrError(text);
  if (parsed) return new HerdrError(parsed.code, parsed.message, args);
  const message =
    (error as { message?: unknown } | null)?.message ?? (error == null ? "unknown error" : String(error));
  return new HerdrError("herdr_error", String(message), args);
}

function herdrExec(args: string[]): string {
  try {
    return execFileSync("herdr", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw toHerdrError(error, args);
  }
}

async function herdrExecAsync(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("herdr", args, {
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    throw toHerdrError(error, args);
  }
}

// ── JSON parsing ────────────────────────────────────────────────────────────

/** Parse a herdr JSON payload; null when the text is not JSON. Pure. */
export function parseHerdrJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `.result.pane.pane_id` — returned by `pane split`. Pure. */
export function extractHerdrPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } } | null)?.result?.pane
    ?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

/** `.result.root_pane.pane_id` — returned by `tab create` / `workspace create`. Pure. */
export function extractHerdrRootPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } } | null)?.result
    ?.root_pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

// ── Argv builders (pure — the unit-testable contract) ───────────────────────

/** `pane split [<pane>] --direction right|down --no-focus [--cwd <path>]` */
export function buildHerdrSplitArgs(
  pane: string | undefined,
  direction: HerdrSplitDirection,
  options?: { cwd?: string },
): string[] {
  const args = ["pane", "split"];
  if (pane) args.push(pane);
  args.push("--direction", herdrSplitDirection(direction), "--no-focus");
  if (options?.cwd) args.push("--cwd", options.cwd);
  return args;
}

/** `tab create --label <name> --no-focus [--cwd <path>]` — split fallback. */
export function buildHerdrTabCreateArgs(label: string, options?: { cwd?: string }): string[] {
  const args = ["tab", "create", "--label", label, "--no-focus"];
  if (options?.cwd) args.push("--cwd", options.cwd);
  return args;
}

/** `pane run <pane> <command>` — atomic text + Enter. */
export function buildHerdrPaneRunArgs(pane: string, command: string): string[] {
  return ["pane", "run", pane, command];
}

/** `pane read <pane> --source <source> --lines <n> --format text` */
export function buildHerdrPaneReadArgs(
  pane: string,
  lines: number,
  source: string = HERDR_READ_SOURCE_PREFERRED,
): string[] {
  return ["pane", "read", pane, "--source", source, "--lines", String(lines), "--format", "text"];
}

/** `agent read <target> --source <source> --lines <n> --format text` */
export function buildHerdrAgentReadArgs(
  target: string,
  lines: number,
  source: string = HERDR_READ_SOURCE_PREFERRED,
): string[] {
  return ["agent", "read", target, "--source", source, "--lines", String(lines), "--format", "text"];
}

/**
 * Escape delivery. `agent send-keys <target> esc` is turn-level and works when
 * herdr recognises the pane as an agent; `pane send-keys <pane> esc` is the
 * pane-level fallback.
 */
export function buildHerdrEscapeArgs(target: string, viaAgent: boolean): string[] {
  return [(viaAgent ? "agent" : "pane"), "send-keys", target, HERDR_ESC_KEY];
}

/** `pane rename <pane> <label>` — cosmetic. */
export function buildHerdrPaneRenameArgs(pane: string, label: string): string[] {
  return ["pane", "rename", pane, label];
}

/** `tab rename <tab_id> <label>` — cosmetic. */
export function buildHerdrTabRenameArgs(tabId: string, label: string): string[] {
  return ["tab", "rename", tabId, label];
}

/** `workspace rename <workspace_id> <label>` — cosmetic. */
export function buildHerdrWorkspaceRenameArgs(workspaceId: string, label: string): string[] {
  return ["workspace", "rename", workspaceId, label];
}

/** `agent start <name> --kind pi --pane <id> --timeout <ms> [-- <agent args>]` */
export function buildHerdrAgentStartArgs(
  name: string,
  pane: string,
  options?: { kind?: string; timeoutMs?: number; args?: string[] },
): string[] {
  const args = [
    "agent",
    "start",
    name,
    "--kind",
    options?.kind ?? "pi",
    "--pane",
    pane,
    "--timeout",
    String(options?.timeoutMs ?? HERDR_AGENT_START_TIMEOUT_MS),
  ];
  if (options?.args && options.args.length > 0) {
    args.push("--", ...options.args);
  }
  return args;
}

/** `agent prompt <target> <text> [--wait] [--until <s>]... [--timeout <ms>]` */
export function buildHerdrAgentPromptArgs(
  target: string,
  text: string,
  options?: { wait?: boolean; until?: string[]; timeoutMs?: number },
): string[] {
  const args = ["agent", "prompt", target, text];
  if (options?.wait !== false) {
    args.push("--wait");
  }
  for (const state of options?.until ?? ["done", "idle"]) {
    args.push("--until", state);
  }
  const timeoutMs = options?.timeoutMs ?? HERDR_AGENT_PROMPT_TIMEOUT_MS;
  if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
  return args;
}

/** `agent wait <target> [--until <s>]... [--timeout <ms>]` */
export function buildHerdrAgentWaitArgs(
  target: string,
  options?: { until?: string[]; timeoutMs?: number },
): string[] {
  const args = ["agent", "wait", target];
  for (const state of options?.until ?? ["done", "idle"]) {
    args.push("--until", state);
  }
  const timeoutMs = options?.timeoutMs ?? HERDR_AGENT_WAIT_TIMEOUT_MS;
  if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
  return args;
}

// ── Current pane identity ───────────────────────────────────────────────────

export function getHerdrParentPaneId(): string | null {
  return process.env.HERDR_PANE_ID ?? null;
}

/**
 * Current pane identity, env-first (herdr injects it) with a `pane current`
 * fallback for older builds that do not set all three variables.
 */
export function getHerdrCurrentPaneInfo(): {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
} | null {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (paneId && tabId && workspaceId) {
    return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
  }

  try {
    const parsed = parseHerdrJson(herdrExec(["pane", "current"]));
    const pane = (parsed as { result?: { pane?: unknown } } | null)?.result?.pane as
      | { pane_id?: string; tab_id?: string; workspace_id?: string }
      | undefined;
    if (pane?.pane_id && pane.tab_id && pane.workspace_id) {
      return { pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id };
    }
  } catch {
    // Best-effort only — cosmetic renames degrade to a no-op.
  }
  return null;
}

// ── Surface creation ────────────────────────────────────────────────────────

function renameHerdrPane(pane: string, name: string): void {
  try {
    herdrExec(buildHerdrPaneRenameArgs(pane, name));
  } catch {
    // Cosmetic — the pane label is not part of the subagent contract.
  }
}

/**
 * Create the pane a subagent runs in: `pane split --no-focus` from the parent
 * pane, falling back to a fresh tab when the split is refused (for example no
 * room left in the tab). `--no-focus` keeps the user's focus on the parent,
 * which is what makes parallel spawns usable.
 */
export function createHerdrSurface(name: string): string {
  const parent = getHerdrParentPaneId();
  const cwd = process.cwd();

  let paneId: string;
  try {
    paneId = extractHerdrPaneId(
      herdrExec(buildHerdrSplitArgs(parent ?? undefined, "right", { cwd })),
      "pane split",
    );
  } catch (error) {
    if (isHerdrErrorCode(error, "server_not_running")) throw error;
    try {
      paneId = extractHerdrRootPaneId(
        herdrExec(buildHerdrTabCreateArgs(name, { cwd })),
        "tab create",
      );
    } catch (tabError) {
      const first = error instanceof Error ? error.message : String(error);
      const second = tabError instanceof Error ? tabError.message : String(tabError);
      throw new Error(`Could not create a herdr pane for "${name}".\nsplit: ${first}\ntab create: ${second}`);
    }
  }

  renameHerdrPane(paneId, name);
  return paneId;
}

/**
 * Split an explicit pane (or the parent) in the requested direction. Used by
 * the mux harness/tests; no tab fallback, because the caller asked for a split.
 */
export function createHerdrSurfaceSplit(
  name: string,
  direction: HerdrSplitDirection,
  fromSurface?: string,
): string {
  const target = fromSurface ?? getHerdrParentPaneId();
  const paneId = extractHerdrPaneId(
    herdrExec(buildHerdrSplitArgs(target ?? undefined, direction, { cwd: process.cwd() })),
    "pane split",
  );
  renameHerdrPane(paneId, name);
  return paneId;
}

// ── Delivery / read / interrupt ─────────────────────────────────────────────

/** Deliver a shell command atomically (text + Enter in one socket request). */
export function sendHerdrCommand(surface: string, command: string): void {
  herdrExec(buildHerdrPaneRunArgs(surface, command));
}

/**
 * Probe whether herdr recognises the pane as a live agent.
 *
 * `agent get <pane>` answers with `agent_not_found` for a plain shell pane.
 * `false` is memoised only for a clean `agent_not_found`; transient failures
 * (server down, timeouts) are not cached so a later call can still succeed.
 */
const agentProbeCache = new Map<string, boolean>();

export function isHerdrAgent(surface: string): boolean {
  const cached = agentProbeCache.get(surface);
  if (cached !== undefined) return cached;

  try {
    herdrExec(["agent", "get", surface]);
    agentProbeCache.set(surface, true);
    return true;
  } catch (error) {
    if (isHerdrErrorCode(error, "agent_not_found")) {
      agentProbeCache.set(surface, false);
    }
    return false;
  }
}

/** Agent status string (`idle` | `working` | `blocked` | `done` | …) or null. */
export function getHerdrAgentStatus(surface: string): string | null {
  try {
    const parsed = parseHerdrJson(herdrExec(["agent", "get", surface]));
    const status = (parsed as { result?: { agent?: { agent_status?: unknown } } } | null)?.result
      ?.agent?.agent_status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

function readHerdrFrom(
  viaAgent: boolean,
  surface: string,
  lines: number,
  source: string,
): string {
  const args = viaAgent
    ? buildHerdrAgentReadArgs(surface, lines, source)
    : buildHerdrPaneReadArgs(surface, lines, source);
  return herdrExec(args);
}

/**
 * Read pane output.
 *
 * Order: the agent facade (unwrap-aware) when herdr knows the pane, then
 * `pane read` with the preferred source, then one bounded retry with the
 * fallback source for builds that reject `recent-unwrapped`.
 */
export function readHerdrScreen(surface: string, lines = 50): string {
  if (isHerdrAgent(surface)) {
    try {
      return readHerdrFrom(true, surface, lines, HERDR_READ_SOURCE_PREFERRED);
    } catch (error) {
      if (isHerdrErrorCode(error, "server_not_running")) throw error;
      // Fall through to the pane-level read below.
    }
  }

  try {
    return readHerdrFrom(false, surface, lines, HERDR_READ_SOURCE_PREFERRED);
  } catch (error) {
    if (isHerdrErrorCode(error, "pane_not_found") || isHerdrErrorCode(error, "server_not_running")) {
      throw error;
    }
    return readHerdrFrom(false, surface, lines, HERDR_READ_SOURCE_FALLBACK);
  }
}

/** Async variant of {@link readHerdrScreen} (same order, same fallbacks). */
export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
  const viaAgent = isHerdrAgent(surface);

  const attempt = async (agent: boolean, source: string): Promise<string> => {
    const args = agent
      ? buildHerdrAgentReadArgs(surface, lines, source)
      : buildHerdrPaneReadArgs(surface, lines, source);
    return herdrExecAsync(args);
  };

  if (viaAgent) {
    try {
      return await attempt(true, HERDR_READ_SOURCE_PREFERRED);
    } catch (error) {
      if (isHerdrErrorCode(error, "server_not_running")) throw error;
      // Fall through to the pane-level read below.
    }
  }

  try {
    return await attempt(false, HERDR_READ_SOURCE_PREFERRED);
  } catch (error) {
    if (isHerdrErrorCode(error, "pane_not_found") || isHerdrErrorCode(error, "server_not_running")) {
      throw error;
    }
    return await attempt(false, HERDR_READ_SOURCE_FALLBACK);
  }
}

/**
 * Send one Escape keypress: turn-level via the agent facade when the pane is a
 * recognised agent, else pane-level. A facade refusal falls back to the pane.
 */
export function sendHerdrEscape(surface: string): void {
  if (isHerdrAgent(surface)) {
    try {
      herdrExec(buildHerdrEscapeArgs(surface, true));
      return;
    } catch (error) {
      if (isHerdrErrorCode(error, "server_not_running")) throw error;
      // Fall through to the pane-level Escape.
    }
  }
  herdrExec(buildHerdrEscapeArgs(surface, false));
}

// ── Close (safety-guarded) ──────────────────────────────────────────────────

/**
 * Close a pane the plugin created. Refuses the parent pane, and treats an
 * already-gone pane as done (idempotent tidy-up). Nothing else is tolerated.
 */
export function closeHerdrSurface(surface: string): void {
  const parent = getHerdrParentPaneId();
  if (parent && surface === parent) {
    throw new Error(`Refusing to close the herdr parent pane (${surface}).`);
  }

  try {
    herdrExec(["pane", "close", surface]);
  } catch (error) {
    if (isHerdrErrorCode(error, "pane_not_found")) return;
    throw error;
  }
}

// ── Renames (cosmetic, best-effort) ─────────────────────────────────────────

export function renameHerdrTab(title: string): void {
  const info = getHerdrCurrentPaneInfo();
  if (!info) return;
  herdrExec(buildHerdrTabRenameArgs(info.tab_id, title));
}

export function renameHerdrWorkspace(title: string): void {
  const info = getHerdrCurrentPaneInfo();
  if (!info) return;
  herdrExec(buildHerdrWorkspaceRenameArgs(info.workspace_id, title));
}

// ── Agent facade ────────────────────────────────────────────────────────────

/**
 * Start a supported agent in an existing pane.
 *
 * NOTE: the plugin's own launch does NOT use this (see the module header) —
 * it cannot carry the env prefix or the exit sentinel. This is the documented
 * facade primitive for panes that are not started by the plugin's launch
 * script, and it is covered by unit + contract tests.
 */
export function herdrAgentStart(options: {
  name: string;
  pane: string;
  kind?: string;
  timeoutMs?: number;
  args?: string[];
}): void {
  herdrExec(buildHerdrAgentStartArgs(options.name, options.pane, options));
}

/**
 * Submit a prompt and wait for the first matching state observed afterwards.
 * Returns true when a target state was matched, false on any other failure
 * (`agent_blocked`, `agent_prompt_stalled`, `timeout`, …). `server_not_running`
 * always propagates.
 */
export function herdrAgentPromptWait(options: {
  target: string;
  text: string;
  until?: string[];
  timeoutMs?: number;
}): boolean {
  try {
    herdrExec(buildHerdrAgentPromptArgs(options.target, options.text, options));
    return true;
  } catch (error) {
    if (isHerdrErrorCode(error, "server_not_running")) throw error;
    return false;
  }
}

/** Wait for an agent to reach one of `until` (default: done, idle). */
export function herdrAgentWait(options: {
  target: string;
  until?: string[];
  timeoutMs?: number;
}): boolean {
  try {
    herdrExec(buildHerdrAgentWaitArgs(options.target, options));
    return true;
  } catch (error) {
    if (isHerdrErrorCode(error, "server_not_running")) throw error;
    return false;
  }
}

/**
 * Completion accelerator used by `pollForExit`.
 *
 * When herdr recognises the pane as an agent, wait (bounded) for it to settle
 * — `done` or `idle` — instead of sleeping the full poll interval, so the
 * sentinel/sidecar is picked up as soon as the turn ends. Returns false
 * whenever the pane is not a recognised agent or the wait does not match, in
 * which case the caller keeps its normal cadence. The `.exit` sidecar and the
 * screen sentinel remain the authoritative result signals.
 */
export function waitForHerdrAgentSettle(
  surface: string,
  options?: { timeoutMs?: number },
): boolean {
  if (!isHerdrAgent(surface)) return false;
  const timeoutMs = options?.timeoutMs ?? HERDR_AGENT_WAIT_TIMEOUT_MS;
  if (timeoutMs <= 0) return false;
  return herdrAgentWait({ target: surface, until: ["done", "idle"], timeoutMs });
}

// ── Test surface ────────────────────────────────────────────────────────────

export const __herdrTest__ = {
  hasCommand,
  toHerdrError,
  herdrSplitDirection,
  buildHerdrSplitArgs,
  buildHerdrTabCreateArgs,
  buildHerdrPaneRunArgs,
  buildHerdrPaneReadArgs,
  buildHerdrAgentReadArgs,
  buildHerdrEscapeArgs,
  buildHerdrPaneRenameArgs,
  buildHerdrTabRenameArgs,
  buildHerdrWorkspaceRenameArgs,
  buildHerdrAgentStartArgs,
  buildHerdrAgentPromptArgs,
  buildHerdrAgentWaitArgs,
  parseHerdrVersion,
  compareHerdrVersions,
  parseHerdrError,
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
  herdrEnvDetected,
  isHerdrErrorCode,
  herdrErrorHint,
};
