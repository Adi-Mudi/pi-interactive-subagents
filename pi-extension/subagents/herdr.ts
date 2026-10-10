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
 * 4. Never create a herdr tab (v3.8.3, same-tab-only): this module emits no
 *    `tab create` argv at all. A full tab degrades INSIDE the tab (overflow
 *    reclaim of a finished pane) and finally fails loudly (F5a/F6).
 * 5. Never split a pane we do not own: the placement path requires
 *    `HERDR_PANE_ID` (`requireHerdrParentPaneId`) and `buildHerdrSplitArgs`
 *    makes the pane argument mandatory, because a pane-less `pane split` makes
 *    herdr target the caller's *current* - possibly foreign - pane. Measured
 *    live: see .IDE_Plans/probe-v383/phase0-evidence.md §E-5.
 * 6. Placement is serialised across processes with a lock file next to the
 *    herdr socket (`withHerdrPlacementLock`, F4a): two pi sessions spawning
 *    into the same tab cannot interleave their split + resize passes.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// ── Layout geometry (two-column stacked placement) ──────────────────────────

/**
 * herdr stacks panes as nested rect splits, so splitting the parent RIGHT again
 * for every scout squeezes every earlier pane into a narrow strip. The policy
 * below keeps the parent at ~50% of the tab and grows ONE right-hand column:
 * the first scout splits the parent right, every later scout splits the bottom
 * pane of that column down, and a short resize pass re-equalises the column.
 *
 * Measured against herdr 0.9.3 (the numbers these helpers rely on):
 *   - `pane split <pane> --direction right|down --ratio F` divides that pane's
 *     own rect: the original keeps F, the new pane gets 1-F.
 *   - `pane resize --pane <pane> --direction up|down|left|right --amount A`
 *     moves the boundary adjacent to that pane in that direction by
 *     A x the owning split's extent, so A maps 1:1 onto that split's ratio.
 *   - `pane layout --pane <pane>` reports every rect and split ratio, which is
 *     all the arithmetic needs.
 *
 * See .IDE_Plans/herdr-two-column-layout-fix_plan_20261010_2003_v1.0.md §Design.
 */

/** Below this many rows a fresh stacked pane is unreadable -> new column. */
export const HERDR_DEFAULT_MIN_PANE_HEIGHT = 8;
/** Below this many columns a fresh column is unusable -> overflow reclaim. */
export const HERDR_DEFAULT_MIN_COLUMN_WIDTH = 24;
/** Share of the tab width the calling pi pane keeps. */
export const HERDR_PARENT_WIDTH_SHARE = 0.5;
/** Resize passes per spawn; a second pass only fixes +/-1 rounding drift. */
export const HERDR_LAYOUT_MAX_PASSES = 2;
/** Placement lock (F4a): how long to wait for the cross-process lock. */
export const HERDR_PLACEMENT_LOCK_DEFAULT_TIMEOUT_MS = 5_000;
/** Placement lock (F4a): a lock older than this belonged to a dead process. */
export const HERDR_PLACEMENT_LOCK_DEFAULT_STALE_MS = 30_000;
/** EC-3 accounting: hard cap on the managed-pane registry (oldest evicted). */
export const HERDR_MANAGED_PANE_LIMIT = 256;

/** Ignore resize deltas below this many rows/columns (rounding noise). */
const HERDR_MIN_RESIZE_EXTENT = 1;

export interface HerdrPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrPanePlacement {
  paneId: string;
  rect: HerdrPaneRect;
}

export interface HerdrSplitInfo {
  id: string;
  direction: string;
  ratio: number;
  rect: HerdrPaneRect;
}

export interface HerdrLayoutSnapshot {
  area: HerdrPaneRect;
  panes: HerdrPanePlacement[];
  splits: HerdrSplitInfo[];
  zoomed: boolean;
  focusedPaneId?: string;
  tabId?: string;
}

/** Panes sharing an x offset inside the right-hand region, top -> bottom. */
export interface HerdrColumn {
  x: number;
  width: number;
  panes: HerdrPanePlacement[];
}

export type HerdrResizeDirection = "left" | "right" | "up" | "down";

export interface HerdrResizeStep {
  pane: string;
  direction: HerdrResizeDirection;
  amount: number;
}

/**
 * `stack` splits a column pane down; `new-column` splits the parent right;
 * `overflow` means the target column is full and no new column fits, so the
 * caller reclaims a finished pane (`reclaimPane`) and re-plans. Never a tab.
 */
export type HerdrScoutPlacementMode = "stack" | "new-column" | "overflow";

export interface HerdrScoutPlacement {
  mode: HerdrScoutPlacementMode;
  splitPane: string | null;
  splitDirection: "right" | "down";
  splitRatio: number;
  /** Resize steps known before the split; the executor recomputes after it. */
  resizes: HerdrResizeStep[];
  reason: string;
  /** `overflow` only: the finished pane to close before re-planning (F1a). */
  reclaimPane?: string | null;
}

export interface HerdrPlacementOptions {
  parentPaneId: string;
  minPaneHeight?: number;
  minColumnWidth?: number;
  /** Panes whose subagent already finished (oldest first) — overflow reclaim. */
  finishedPaneIds?: string[];
}

/** `column` only equalises the right-most column; `layout` also pins widths. */
export type HerdrGeometryScope = "column" | "layout";

export interface HerdrGeometryOptions {
  parentPaneId: string;
  scope: HerdrGeometryScope;
  minPaneHeight?: number;
  minColumnWidth?: number;
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Min rows per stacked pane; `PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT` overrides. */
export function getHerdrMinPaneHeight(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env, "PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT", HERDR_DEFAULT_MIN_PANE_HEIGHT);
}

/** Min columns per column; `PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH` overrides. */
export function getHerdrMinColumnWidth(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env, "PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH", HERDR_DEFAULT_MIN_COLUMN_WIDTH);
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

// ── Layout geometry: snapshot parsing ──────────────────────────────────────

function parseHerdrRect(value: unknown): HerdrPaneRect | null {
  const rect = value as Partial<HerdrPaneRect> | null | undefined;
  if (!rect || typeof rect !== "object") return null;
  const { x, y, width, height } = rect;
  const numbers = [x, y, width, height];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * `pane layout --pane <id>` JSON -> snapshot. Pure; null when the payload is
 * not a layout (a missing key degrades the layout pass, never the spawn).
 */
export function parseHerdrLayout(output: string): HerdrLayoutSnapshot | null {
  const parsed = parseHerdrJson(output) as { result?: { layout?: unknown } } | null;
  const layout = parsed?.result?.layout as Record<string, unknown> | undefined;
  if (!layout || typeof layout !== "object") return null;
  const area = parseHerdrRect(layout.area);
  if (!area) return null;

  const panes: HerdrPanePlacement[] = [];
  for (const entry of Array.isArray(layout.panes) ? layout.panes : []) {
    const paneId = (entry as { pane_id?: unknown })?.pane_id;
    const rect = parseHerdrRect((entry as { rect?: unknown })?.rect);
    if (typeof paneId === "string" && paneId && rect) panes.push({ paneId, rect });
  }

  const splits: HerdrSplitInfo[] = [];
  for (const entry of Array.isArray(layout.splits) ? layout.splits : []) {
    const id = (entry as { id?: unknown })?.id;
    const direction = (entry as { direction?: unknown })?.direction;
    const ratio = (entry as { ratio?: unknown })?.ratio;
    const rect = parseHerdrRect((entry as { rect?: unknown })?.rect);
    if (
      typeof id === "string" &&
      typeof direction === "string" &&
      typeof ratio === "number" &&
      rect
    ) {
      splits.push({ id, direction, ratio, rect });
    }
  }

  return {
    area,
    panes,
    splits,
    zoomed: layout.zoomed === true,
    focusedPaneId: typeof layout.focused_pane_id === "string" ? layout.focused_pane_id : undefined,
    tabId: typeof layout.tab_id === "string" ? layout.tab_id : undefined,
  };
}

/** Live geometry for a pane; null on any failure (layout work is cosmetic). */
export function getHerdrPaneLayout(pane: string): HerdrLayoutSnapshot | null {
  try {
    return parseHerdrLayout(herdrExec(buildHerdrPaneLayoutArgs(pane)));
  } catch {
    return null;
  }
}

// ── Argv builders (pure — the unit-testable contract) ───────────────────────

/**
 * `pane split <pane> --direction right|down [--ratio <f>] --no-focus [--cwd <p>]`
 *
 * The pane argument is MANDATORY (F9): omitting it makes herdr split the
 * caller's current pane, which may be a pane this plugin does not own.
 */
export function buildHerdrSplitArgs(
  pane: string,
  direction: HerdrSplitDirection,
  options?: { cwd?: string; ratio?: number },
): string[] {
  if (!pane) {
    throw new Error(
      "Refusing to build a pane-less `pane split`: herdr would split the caller's current pane (same-tab-only guard, F9).",
    );
  }
  return [
    "pane",
    "split",
    pane,
    "--direction",
    herdrSplitDirection(direction),
    ...(typeof options?.ratio === "number" ? ["--ratio", String(options.ratio)] : []),
    "--no-focus",
    ...(options?.cwd ? ["--cwd", options.cwd] : []),
  ];
}

/** `pane layout --pane <pane>` — geometry snapshot (rects + split ratios). */
export function buildHerdrPaneLayoutArgs(pane: string): string[] {
  return ["pane", "layout", "--pane", pane];
}

/** `pane resize --pane <pane> --direction <dir> --amount <float>` */
export function buildHerdrResizeArgs(
  pane: string,
  direction: HerdrResizeDirection,
  amount: number,
): string[] {
  return ["pane", "resize", "--pane", pane, "--direction", direction, "--amount", String(amount)];
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
 * The parent pane id, or a loud same-tab-only error (F6/F9).
 *
 * A placement without a parent id would let herdr resolve the *current* pane,
 * which may belong to another workspace/tab (measured live: a pane-less split
 * created a pane in the user's workspace while the probe's own tab was
 * untouched — .IDE_Plans/probe-v383/phase0-evidence.md §E-5).
 */
export function requireHerdrParentPaneId(env: NodeJS.ProcessEnv = process.env): string {
  const parent = env.HERDR_PANE_ID?.trim();
  if (parent) return parent;
  throw new Error(
    [
      "Refusing to place a herdr pane without HERDR_PANE_ID.",
      "Same-tab-only (v3.8.3): a pane split without an explicit pane would target",
      "herdr's current pane, which may not belong to this session's tab.",
      "Start pi inside the herdr pane that should own the subagent panes.",
    ].join("\n"),
  );
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

// ── Layout geometry: planning (pure) + execution ────────────────────────────

// ── Managed panes, finished detection, placement lock ──────────────────────

interface HerdrManagedPaneRecord {
  createdAt: number;
  started: boolean;
}

/**
 * Panes this process created for subagents, oldest first (EC-3 accounting).
 *
 * Only a pane in here can ever be reclaimed: a foreign pane, a persistent
 * scout without the exit sentinel, and the parent are all untouchable.
 */
const herdrManagedPanes = new Map<string, HerdrManagedPaneRecord>();

/** Register a pane this plugin just created (LRU-capped, oldest evicted). */
export function noteHerdrManagedPane(pane: string, now = Date.now()): void {
  if (!pane) return;
  herdrManagedPanes.delete(pane);
  herdrManagedPanes.set(pane, { createdAt: now, started: false });
  while (herdrManagedPanes.size > HERDR_MANAGED_PANE_LIMIT) {
    const oldest = herdrManagedPanes.keys().next();
    if (oldest.done) break;
    herdrManagedPanes.delete(oldest.value);
  }
}

/** Mark a managed pane as carrying a launched subagent. */
export function noteHerdrPaneStarted(pane: string): void {
  const record = herdrManagedPanes.get(pane);
  if (record) record.started = true;
}

/** Drop a pane from the registry (closed, or gone from herdr). */
export function forgetHerdrManagedPane(pane: string): void {
  herdrManagedPanes.delete(pane);
}

/** Managed pane ids, oldest first. */
export function listHerdrManagedPanes(): string[] {
  return [...herdrManagedPanes.keys()];
}

export function herdrManagedPaneCount(): number {
  return herdrManagedPanes.size;
}

export function resetHerdrManagedPanesForTests(): void {
  herdrManagedPanes.clear();
}

/** The exit sentinel the launch script echoes: `__SUBAGENT_DONE_<code>__`. */
export const HERDR_EXIT_SENTINEL_RE = /__SUBAGENT_DONE_\d+__/;

/**
 * True when a managed pane holds a *finished* subagent: created by this plugin,
 * a subagent was launched in it, and the exit sentinel is on screen.
 *
 * A persistent/interactive scout has no sentinel, so it is never reclaimable;
 * any read failure answers false — never reclaim on doubt (F1a/F6).
 */
export function isHerdrSurfaceFinished(
  surface: string,
  deps: {
    isManaged?: (pane: string) => boolean;
    isStarted?: (pane: string) => boolean;
    readScreen?: (pane: string) => string;
  } = {},
): boolean {
  const isManaged = deps.isManaged ?? ((pane: string) => herdrManagedPanes.has(pane));
  const isStarted =
    deps.isStarted ?? ((pane: string) => herdrManagedPanes.get(pane)?.started === true);
  const readScreen = deps.readScreen ?? ((pane: string) => readHerdrScreen(pane, 200));
  if (!isManaged(surface) || !isStarted(surface)) return false;
  try {
    return HERDR_EXIT_SENTINEL_RE.test(readScreen(surface));
  } catch {
    return false;
  }
}

/** Path of the cross-process placement lock (next to the herdr socket, F4a). */
export function getHerdrPlacementLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const socket = env.HERDR_SOCKET_PATH?.trim();
  const base = socket ? path.dirname(socket) : os.tmpdir();
  return path.join(base, "pi-subagent-herdr-placement.lock");
}

export function getHerdrPlacementLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(
    env,
    "PI_SUBAGENT_HERDR_PLACEMENT_TIMEOUT_MS",
    HERDR_PLACEMENT_LOCK_DEFAULT_TIMEOUT_MS,
  );
}

export function getHerdrPlacementStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(
    env,
    "PI_SUBAGENT_HERDR_PLACEMENT_STALE_MS",
    HERDR_PLACEMENT_LOCK_DEFAULT_STALE_MS,
  );
}

/** Synchronous sleep that does not spin the CPU (throwaway shared buffer). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Age of the lock file in ms, or null when it vanished / is unreadable. */
function herdrLockAgeMs(lockPath: string, now: () => number): number | null {
  try {
    return now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Remove the lock file. Never throws (idempotent). */
export function releaseHerdrPlacementLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone - nothing to release.
  }
}

export interface HerdrPlacementLockOptions {
  path?: string;
  timeoutMs?: number;
  staleMs?: number;
  sleep?: (ms: number) => void;
  now?: () => number;
}

/**
 * Take the placement lock (F4a).
 *
 * `fs.openSync(path, "wx")` is the atomic test-and-set. Returns a release
 * handle, or null when the bounded wait elapsed — the caller then proceeds
 * WITHOUT the lock, because a serialisation failure must never fail a spawn.
 * A lock older than the stale budget is stolen once (its owner died).
 */
export function acquireHerdrPlacementLock(
  options: HerdrPlacementLockOptions = {},
): { path: string; stale: boolean; release: () => void } | null {
  const lockPath = options.path ?? getHerdrPlacementLockPath();
  const timeoutMs = options.timeoutMs ?? getHerdrPlacementLockTimeoutMs();
  const staleMs = options.staleMs ?? getHerdrPlacementStaleMs();
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepSync;

  const deadline = now() + timeoutMs;
  let stole = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, stale: stole, release: () => releaseHerdrPlacementLock(lockPath) };
    } catch (error) {
      // Any error other than "already locked" means the lock is unusable (bad
      // directory, permissions): proceed unserialised rather than fail.
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
    }

    if (!stole) {
      const age = herdrLockAgeMs(lockPath, now);
      if (age !== null && age > staleMs) {
        stole = true;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Someone else won the race - just loop and retry the open.
        }
        continue;
      }
    }

    if (now() >= deadline) return null;
    sleep(25);
  }
}

/**
 * Run `fn` under the placement lock. Always released; a timeout degrades to an
 * unlocked run with a warning rather than a failed spawn (F4a).
 */
export function withHerdrPlacementLock<T>(
  fn: () => T,
  options: HerdrPlacementLockOptions = {},
): T {
  const lock = acquireHerdrPlacementLock(options);
  if (!lock) {
    process.emitWarning(
      "herdr placement lock not acquired within the timeout; proceeding unserialised.",
      { code: "PI_HERDR_PLACEMENT_LOCK_TIMEOUT" },
    );
    return fn();
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** Round a boundary amount: herdr takes floats, sub-pixel drift is noise. */
function roundHerdrAmount(amount: number): number {
  return Math.round(amount * 10_000) / 10_000;
}

/** The panes right of `parent`, grouped into columns, left -> right. Pure. */
export function layoutHerdrColumns(
  snapshot: HerdrLayoutSnapshot,
  parentPaneId: string,
): HerdrColumn[] {
  const parent = snapshot.panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return [];
  const parentRight = parent.rect.x + parent.rect.width;

  const groups = new Map<number, HerdrPanePlacement[]>();
  for (const pane of snapshot.panes) {
    if (pane.paneId === parentPaneId || pane.rect.x < parentRight) continue;
    const group = groups.get(pane.rect.x);
    if (group) group.push(pane);
    else groups.set(pane.rect.x, [pane]);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, panes]) => {
      const ordered = [...panes].sort((a, b) => a.rect.y - b.rect.y);
      return { x, width: ordered[0]?.rect.width ?? 0, panes: ordered };
    });
}

function herdrColumnHeight(column: HerdrColumn): number {
  return column.panes.reduce((total, pane) => total + pane.rect.height, 0);
}

/** A split's own boundary on its axis (`down` -> y, `right` -> x). Pure. */
function herdrSplitBoundary(split: HerdrSplitInfo): number {
  return split.direction === "down"
    ? split.rect.y + split.ratio * split.rect.height
    : split.rect.x + split.ratio * split.rect.width;
}

/**
 * The split owning `boundary` — the one whose first child ends there. Matching
 * is geometric (rect ratios are exact, pane rects are floored, hence +/-1);
 * ties prefer the outer split. Pure.
 */
function findHerdrOwningSplit(
  snapshot: HerdrLayoutSnapshot,
  direction: "down" | "right",
  boundary: number,
  where: (split: HerdrSplitInfo) => boolean,
): HerdrSplitInfo | null {
  const candidates = snapshot.splits.filter(
    (split) =>
      split.direction === direction &&
      where(split) &&
      Math.abs(herdrSplitBoundary(split) - boundary) <= 1,
  );
  candidates.sort((a, b) =>
    direction === "down" ? b.rect.height - a.rect.height : b.rect.width - a.rect.width,
  );
  return candidates[0] ?? null;
}

/** Tallest pane whose right edge sits on `boundary` (the lane's left group). */
function herdrPaneEndingAt(snapshot: HerdrLayoutSnapshot, boundary: number): string | null {
  const candidates = snapshot.panes.filter(
    (pane) => Math.abs(pane.rect.x + pane.rect.width - boundary) <= 1,
  );
  candidates.sort((a, b) => b.rect.height - a.rect.height);
  return candidates[0]?.paneId ?? null;
}

/** Tallest pane whose left edge sits on `boundary` (the lane's right group). */
function herdrPaneStartingAt(snapshot: HerdrLayoutSnapshot, boundary: number): string | null {
  const candidates = snapshot.panes.filter((pane) => Math.abs(pane.rect.x - boundary) <= 1);
  candidates.sort((a, b) => b.rect.height - a.rect.height);
  return candidates[0]?.paneId ?? null;
}

/**
 * Steps that make `column` hold `paneCount` equal-height panes. The k-th spine
 * split (top -> bottom) targets 1/(paneCount-k+1) of its own rect, so a fresh
 * `--ratio 0.5` split is already correct and only earlier splits move. Pure.
 */
export function planHerdrColumnSteps(
  snapshot: HerdrLayoutSnapshot,
  column: HerdrColumn,
  paneCount: number,
): HerdrResizeStep[] {
  const steps: HerdrResizeStep[] = [];
  for (let index = 1; index <= paneCount - 1; index += 1) {
    const paneAbove = column.panes[index - 1];
    const paneBelow = column.panes[index];
    if (!paneAbove || !paneBelow) continue; // that split does not exist yet
    const split = findHerdrOwningSplit(
      snapshot,
      "down",
      paneBelow.rect.y,
      (candidate) => candidate.rect.x === column.x,
    );
    if (!split) continue;
    const delta = 1 / (paneCount - index + 1) - split.ratio;
    if (Math.abs(delta) * split.rect.height < HERDR_MIN_RESIZE_EXTENT) continue;
    steps.push({
      pane: delta > 0 ? paneAbove.paneId : paneBelow.paneId,
      direction: delta > 0 ? "down" : "up",
      amount: roundHerdrAmount(Math.abs(delta)),
    });
  }
  return steps;
}

/**
 * The region the parent's own spine lives in (F7).
 *
 * Normally the whole tab area; when the tab itself is split into rows, the
 * smallest full-width `down`-split child rect that contains the parent. Pure.
 */
function herdrParentRowRegion(
  snapshot: HerdrLayoutSnapshot,
  parent: HerdrPanePlacement,
): HerdrPaneRect {
  let best: HerdrPaneRect | null = null;
  for (const split of snapshot.splits) {
    if (split.direction !== "down") continue;
    if (split.rect.x !== snapshot.area.x || split.rect.width !== snapshot.area.width) continue;
    const topHeight = Math.floor(split.rect.height * split.ratio);
    const regions: HerdrPaneRect[] = [
      { x: split.rect.x, y: split.rect.y, width: split.rect.width, height: topHeight },
      {
        x: split.rect.x,
        y: split.rect.y + topHeight,
        width: split.rect.width,
        height: split.rect.height - topHeight,
      },
    ];
    for (const region of regions) {
      const contains =
        parent.rect.y >= region.y &&
        parent.rect.y + parent.rect.height <= region.y + region.height + 1;
      if (contains && (!best || region.height < best.height)) best = region;
    }
  }
  return best ?? snapshot.area;
}

/**
 * Steps that pin the parent at HERDR_PARENT_WIDTH_SHARE of the tab and split
 * the rest evenly across the right-hand columns.
 *
 * Targets use the ratio closed form (2N-k)/(2N-k+1) for the k-th horizontal
 * spine split counted from the OUTERMOST (k = N is the parent's own right
 * edge). That form is independent of the split's current rect, so the steps
 * stay valid while earlier steps move boundaries. Locked decision 4 + F1: the
 * outermost boundary moves first — growing the parent before the new column
 * owns its width crushes that column into a strip. Pure.
 */
export function planHerdrWidthSteps(
  snapshot: HerdrLayoutSnapshot,
  columns: HerdrColumn[],
  parentPaneId: string,
  minColumnWidth = HERDR_DEFAULT_MIN_COLUMN_WIDTH,
): HerdrResizeStep[] {
  const parent = snapshot.panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent || columns.length === 0) return [];

  const columnCount = columns.length;
  const columnWidth = (snapshot.area.width * HERDR_PARENT_WIDTH_SHARE) / columnCount;
  if (columnWidth < minColumnWidth) return [];

  // F7: the spine is scoped to the parent's OWN row region. A tab split into
  // rows has no full-height splits, and the old full-tab filter made this pass
  // bail silently, leaving the parent at 25% (probe §E-3).
  const region = herdrParentRowRegion(snapshot, parent);
  const spine = snapshot.splits
    .filter(
      (split) =>
        split.direction === "right" &&
        split.rect.y === region.y &&
        split.rect.height === region.height,
    )
    .sort((a, b) => b.rect.width - a.rect.width);
  // Anything but one spine split per column is a shape we do not manage.
  if (spine.length !== columnCount) return [];

  const steps: HerdrResizeStep[] = [];
  for (const [rank, split] of spine.entries()) {
    const depth = rank + 1; // 1 = outermost (biggest rect) ... N = parent edge
    const target = (2 * columnCount - depth) / (2 * columnCount - depth + 1);
    const delta = target - split.ratio;
    if (Math.abs(delta) * split.rect.width < HERDR_MIN_RESIZE_EXTENT) continue;
    const boundary = herdrSplitBoundary(split);
    // F9: never move a boundary that lies left of the parent's right edge.
    if (boundary < parent.rect.x + parent.rect.width - 1) continue;
    const pane =
      delta > 0 ? herdrPaneEndingAt(snapshot, boundary) : herdrPaneStartingAt(snapshot, boundary);
    if (!pane) continue;
    steps.push({
      pane,
      direction: delta > 0 ? "right" : "left",
      amount: roundHerdrAmount(Math.abs(delta)),
    });
  }
  return steps;
}

/**
 * Resize steps that bring the live geometry back to the target layout. Pure and
 * idempotent: an empty array means "already correct", which is what ends the
 * executor's pass loop.
 */
export function planHerdrGeometrySteps(
  snapshot: HerdrLayoutSnapshot | null,
  options: HerdrGeometryOptions,
): HerdrResizeStep[] {
  if (!snapshot || snapshot.zoomed) return [];
  const columns = layoutHerdrColumns(snapshot, options.parentPaneId);
  if (columns.length === 0) return [];

  const steps: HerdrResizeStep[] = [];
  if (options.scope === "layout") {
    steps.push(
      ...planHerdrWidthSteps(
        snapshot,
        columns,
        options.parentPaneId,
        options.minColumnWidth ?? HERDR_DEFAULT_MIN_COLUMN_WIDTH,
      ),
    );
  }
  const touched = options.scope === "column" ? columns.slice(-1) : columns;
  for (const column of touched) {
    steps.push(...planHerdrColumnSteps(snapshot, column, column.panes.length));
  }
  return steps;
}

/**
 * Where the next scout pane goes, plus the geometry work known before the
 * split. Pure: no herdr calls, no env reads (guards are arguments).
 *
 * 1. no usable geometry / no column yet -> split the parent right (50/50).
 * 2. column can still hold a legible pane -> split its bottom pane down.
 * 3. column cannot -> a new column (parent right), unless that column would be
 *    narrower than minColumnWidth, in which case the plan is `overflow`: a
 *    SIGNAL for the caller to reclaim a finished pane or degrade in-tab
 *    (F1a/F5a — this plugin never opens a tab).
 */
export function planHerdrScoutPlacement(
  snapshot: HerdrLayoutSnapshot | null,
  options: HerdrPlacementOptions,
): HerdrScoutPlacement {
  const minPaneHeight = options.minPaneHeight ?? HERDR_DEFAULT_MIN_PANE_HEIGHT;
  const minColumnWidth = options.minColumnWidth ?? HERDR_DEFAULT_MIN_COLUMN_WIDTH;
  const splitParentRight = (reason: string): HerdrScoutPlacement => ({
    mode: "stack",
    splitPane: options.parentPaneId,
    splitDirection: "right",
    splitRatio: HERDR_PARENT_WIDTH_SHARE,
    resizes: [],
    reason,
  });

  const hasParent = !!snapshot?.panes.some((pane) => pane.paneId === options.parentPaneId);
  if (!snapshot || snapshot.zoomed || !hasParent) return splitParentRight("no-geometry");

  const columns = layoutHerdrColumns(snapshot, options.parentPaneId);
  if (columns.length === 0) return splitParentRight("first-column");

  const target = columns[columns.length - 1];
  const paneCount = target.panes.length;
  const anchor = target.panes[paneCount - 1];
  const afterSplitHeight = Math.floor(herdrColumnHeight(target) / (paneCount + 1));
  if (afterSplitHeight >= minPaneHeight) {
    return {
      mode: "stack",
      splitPane: anchor.paneId,
      splitDirection: "down",
      splitRatio: 0.5,
      resizes: planHerdrColumnSteps(snapshot, target, paneCount + 1),
      reason: "stack",
    };
  }

  const columnCount = columns.length + 1;
  const columnWidth = (snapshot.area.width * HERDR_PARENT_WIDTH_SHARE) / columnCount;
  if (columnWidth < minColumnWidth) {
    // Same-tab-only (F5a): never a tab. Offer the oldest finished pane in this
    // column for reclaim; the caller closes it and re-plans. With nothing to
    // reclaim it degrades inside the tab (F1a/F6).
    const finished = options.finishedPaneIds ?? [];
    const reclaimPane =
      finished.find((pane) => target.panes.some((placed) => placed.paneId === pane)) ?? null;
    return {
      mode: "overflow",
      splitPane: anchor.paneId,
      splitDirection: "down",
      splitRatio: 0.5,
      resizes: [],
      reason: reclaimPane ? "overflow-reclaim" : "overflow-crowded",
      reclaimPane,
    };
  }

  return {
    // The new pane and its split only exist after the split command, so the
    // executor recomputes the pass from a fresh snapshot (F1 order).
    mode: "new-column",
    splitPane: options.parentPaneId,
    splitDirection: "right",
    splitRatio: HERDR_PARENT_WIDTH_SHARE,
    resizes: [],
    reason: "new-column",
  };
}

/**
 * Execute a placement: split, then run the geometry pass (`herdr pane layout`
 * -> pure steps -> `pane resize`), at most HERDR_LAYOUT_MAX_PASSES times.
 *
 * Returns the new pane id, or null when the caller must fall back (in-tab
 * overflow reclaim/degrade, or a refused/failed split) — never a new tab.
 * Geometry failures are swallowed: a resize can never break a spawn, and
 * `server_not_running` always propagates.
 */
export function applyHerdrLayoutPlan(
  plan: HerdrScoutPlacement,
  options: { parentPaneId: string; cwd?: string; minPaneHeight?: number; minColumnWidth?: number },
): string | null {
  if (!plan.splitPane) return null;
  // F1a: an overflow plan is a SIGNAL, not an action. The caller decides
  // between reclaiming a finished pane and degrading in-tab (with the height
  // guard relaxed), because only it can read the screen and close a pane.
  if (plan.mode === "overflow") return null;

  let paneId: string;
  try {
    paneId = extractHerdrPaneId(
      herdrExec(
        buildHerdrSplitArgs(plan.splitPane, plan.splitDirection, {
          cwd: options.cwd,
          ratio: plan.splitRatio,
        }),
      ),
      "pane split",
    );
  } catch (error) {
    if (isHerdrErrorCode(error, "server_not_running")) throw error;
    return null;
  }

  // Direction invariant (F3): a scout pane belongs RIGHT of the parent. A
  // resize cannot reorder panes, so a reversed result is repaired by closing
  // our own fresh pane and splitting the parent right instead (one retry).
  const kept = enforceHerdrSplitDirection(paneId, options.parentPaneId, { cwd: options.cwd });
  if (!kept) return null;
  paneId = kept;

  const geometryOptions = {
    parentPaneId: options.parentPaneId,
    minPaneHeight: options.minPaneHeight,
    minColumnWidth: options.minColumnWidth,
  };
  for (const scope of herdrPlacementGeometryScopes(plan)) {
    runHerdrGeometryPasses({ ...geometryOptions, scope });
  }

  return paneId;
}

/**
 * Geometry passes a placement needs, in order (pure).
 *
 * `new-column` pins the widths once; a `no-geometry` plan split the parent
 * without a snapshot, so it needs a layout-scope pass afterwards or the parent
 * stays at 25% (F8, probe §E-4). Everything else equalises the column.
 */
export function herdrPlacementGeometryScopes(plan: HerdrScoutPlacement): HerdrGeometryScope[] {
  if (plan.mode === "new-column") return ["layout"];
  return plan.reason === "no-geometry" ? ["column", "layout"] : ["column"];
}

/** Run the resize passes until a pass is a no-op (or the pass budget is used). */
function runHerdrGeometryPasses(
  options: HerdrGeometryOptions,
  passes = HERDR_LAYOUT_MAX_PASSES,
): void {
  for (let pass = 1; pass <= passes; pass += 1) {
    const steps = planHerdrGeometrySteps(getHerdrPaneLayout(options.parentPaneId), options);
    if (steps.length === 0) break;
    for (const step of steps) {
      try {
        herdrExec(buildHerdrResizeArgs(step.pane, step.direction, step.amount));
      } catch {
        // Cosmetic: a refused resize (tab too small, pane closed mid-pass)
        // must never break the spawn.
      }
    }
  }
}

/**
 * Keep a fresh pane only when it is not left of the parent (F3).
 *
 * Returns the pane to keep (`paneId` unchanged, or a replacement created by
 * re-splitting the parent right), or null when the repair could not produce a
 * pane — the caller then falls back instead of running a dead surface.
 */
function enforceHerdrSplitDirection(
  paneId: string,
  parentPaneId: string,
  options: { cwd?: string } = {},
): string | null {
  const snapshot = getHerdrPaneLayout(parentPaneId);
  const parent = snapshot?.panes.find((pane) => pane.paneId === parentPaneId);
  const created = snapshot?.panes.find((pane) => pane.paneId === paneId);
  // No snapshot (or the pane is not visible yet): keep what herdr gave us.
  if (!parent || !created || created.rect.x >= parent.rect.x) return paneId;

  forgetHerdrManagedPane(paneId);
  try {
    closeHerdrSurface(paneId);
  } catch {
    return paneId;
  }
  try {
    return extractHerdrPaneId(
      herdrExec(
        buildHerdrSplitArgs(parentPaneId, "right", {
          cwd: options.cwd,
          ratio: HERDR_PARENT_WIDTH_SHARE,
        }),
      ),
      "pane split",
    );
  } catch (error) {
    if (isHerdrErrorCode(error, "server_not_running")) throw error;
    return null;
  }
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
 * Create the pane a subagent runs in, following the two-column layout policy:
 * scout 1 splits the parent RIGHT 50/50, later scouts stack DOWN inside that
 * column, and a resize pass keeps the column even and the parent at ~50%. A new
 * column starts only when the current one can no longer hold a legible pane; a
 * column too narrow to add another reclaims a finished pane, or (as the last
 * resort) degrades inside the tab.
 *
 * SAME-TAB-ONLY (v3.8.3): this never creates a herdr tab. A placement that
 * cannot land inside the tab fails loudly instead (F5a/F6). `--no-focus` keeps
 * the user's focus on the parent, which is what makes parallel spawns usable.
 *
 * The whole placement runs under the cross-process placement lock so two pi
 * sessions spawning into the same tab cannot interleave their split + resize
 * passes (F4a).
 */
export function createHerdrSurface(name: string): string {
  return withHerdrPlacementLock(() => createHerdrSurfaceLocked(name));
}

function createHerdrSurfaceLocked(name: string): string {
  // F9: without a parent id herdr would resolve the CALLER's current pane, so
  // refuse before emitting any argv (never touch a foreign pane).
  const parent = requireHerdrParentPaneId();
  const cwd = process.cwd();
  const baseOptions: HerdrPlacementOptions = {
    parentPaneId: parent,
    minPaneHeight: getHerdrMinPaneHeight(),
    minColumnWidth: getHerdrMinColumnWidth(),
  };

  const runOnce = (finishedPaneIds: string[] = []) => {
    const plan = planHerdrScoutPlacement(getHerdrPaneLayout(parent), {
      ...baseOptions,
      finishedPaneIds,
    });
    return { plan, paneId: applyHerdrLayoutPlan(plan, { ...baseOptions, cwd }) };
  };

  /** Managed panes whose subagent already finished, oldest first (EC-3/F1a). */
  const collectFinished = (): string[] =>
    listHerdrManagedPanes().filter((pane) => pane !== parent && isHerdrSurfaceFinished(pane));

  let { plan, paneId } = runOnce();
  if (!paneId && plan.mode === "stack" && plan.splitPane !== parent) {
    // Only a column-pane split can lose its anchor to a closing subagent, so
    // re-read the layout once before giving up on the plan.
    ({ plan, paneId } = runOnce());
  }

  if (!paneId && plan.mode === "overflow") {
    const finished = collectFinished();
    const reclaim = finished.length > 0 ? runOnce(finished).plan.reclaimPane : null;
    if (reclaim) {
      try {
        closeHerdrSurface(reclaim);
        ({ plan, paneId } = runOnce(finished));
      } catch {
        // A refused reclaim (gone/foreign pane) degrades to the in-tab fix below.
      }
    }
    if (!paneId) {
      // Nothing reclaimable: every pane in the column is live or persistent.
      // Degrade INSIDE the tab — split the column bottom down at 0.5 and run
      // one layout pass with the height guard relaxed. Sub-min rows are the
      // documented price of same-tab-only (F1a/F6).
      plan = {
        mode: "stack",
        splitPane: plan.splitPane,
        splitDirection: "down",
        splitRatio: 0.5,
        resizes: [],
        reason: "overflow-degrade",
      };
      paneId = applyHerdrLayoutPlan(plan, { ...baseOptions, cwd, minPaneHeight: 0 });
    }
  }

  if (!paneId) {
    // Last resort inside the tab: a plain parent split (never a tab — F5a).
    try {
      paneId = extractHerdrPaneId(
        herdrExec(buildHerdrSplitArgs(parent, "right", { cwd, ratio: HERDR_PARENT_WIDTH_SHARE })),
        "pane split",
      );
    } catch (error) {
      if (isHerdrErrorCode(error, "server_not_running")) throw error;
    }
  }

  if (!paneId) {
    // F6: the documented loud last resort. No tab is ever created.
    throw new Error(
      [
        `Could not place a herdr pane for "${name}" inside the current tab.`,
        `parent pane: ${parent}`,
        `placement: ${plan.mode} (${plan.reason})`,
        "Same-tab-only is enforced since v3.8.3: this plugin never creates a herdr tab.",
        "The tab has no room for another split, and no finished pane in the target",
        "column could be reclaimed.",
        "Fix: close finished scout panes in this tab, enlarge the tab, or lower",
        "PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT.",
      ].join("\n"),
    );
  }

  noteHerdrManagedPane(paneId);
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
  const target = fromSurface ?? requireHerdrParentPaneId();
  const paneId = extractHerdrPaneId(
    herdrExec(buildHerdrSplitArgs(target, direction, { cwd: process.cwd() })),
    "pane split",
  );
  noteHerdrManagedPane(paneId);
  renameHerdrPane(paneId, name);
  return paneId;
}

// ── Delivery / read / interrupt ─────────────────────────────────────────────

/** Deliver a shell command atomically (text + Enter in one socket request). */
export function sendHerdrCommand(surface: string, command: string): void {
  herdrExec(buildHerdrPaneRunArgs(surface, command));
  // EC-3: only a pane whose launch command was delivered can be "finished".
  noteHerdrPaneStarted(surface);
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
    if (isHerdrErrorCode(error, "pane_not_found")) {
      forgetHerdrManagedPane(surface);
      return;
    }
    throw error;
  }
  forgetHerdrManagedPane(surface);
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
  requireHerdrParentPaneId,
  herdrPlacementGeometryScopes,
  herdrEnvDetected,
  isHerdrErrorCode,
  herdrErrorHint,
  // Managed-pane registry + finished detection (EC-3/F1a).
  noteHerdrManagedPane,
  noteHerdrPaneStarted,
  forgetHerdrManagedPane,
  listHerdrManagedPanes,
  herdrManagedPaneCount,
  resetHerdrManagedPanesForTests,
  isHerdrSurfaceFinished,
  // Cross-process placement lock (F4a).
  getHerdrPlacementLockPath,
  getHerdrPlacementLockTimeoutMs,
  getHerdrPlacementStaleMs,
  acquireHerdrPlacementLock,
  releaseHerdrPlacementLock,
  withHerdrPlacementLock,
};
