/**
 * F2 repro harness — 4-parallel `subagent()` spawns through the plugin path.
 *
 * Evidence-gathering integration test (H1 first), per
 * `.IDE_Plans/herdr-parallel-spawn-fix_plan_20261010_1310_v1.1.md` §Phase 1.
 *
 * GATED: this harness spawns REAL LLM agents, so it is skipped unless
 * `RUN_REPRO=1` is set — `npm run test:integration` and CI skip it by default.
 *
 * It drives REAL parent pi sessions that call the subagent tool `BATCH` times
 * in ONE message (the P7 batch shape) and records, per child pane, whether the
 * launch was actually delivered:
 *
 *   launched+delivered — the marker file appeared (the full path worked)
 *   launched-slow      — herdr knows a live agent in the pane, marker late/absent
 *   typed-only         — the `bash …/subagent-scripts/….sh` line is on screen,
 *                        but no pi ever ran from it (keystrokes landed, the
 *                        script did not start)
 *   bare-shell         — only the shell prompt is visible: nothing was typed
 *                        into the pane → keystroke loss (H1)
 *   other              — anything else (screen tail recorded for the report)
 *
 * The test does NOT fail on observed loss — it is the Phase 1 evidence run.
 * It fails only when the harness itself cannot run to completion.
 *
 * Evidence artifact (per run, overwritten as iterations advance):
 *   `.IDE_Plans/herdr-parallel-spawn-fix/runs/repro-<ts>.json`
 *
 * Isolation: the run creates its own tab with `--workspace <ws> --no-focus`
 * (default `w0`, P7's workspace) so the user's active workspace is never
 * touched, and closes every pane it created in `after()`.
 *
 * Run (from a herdr-managed pane, in the fix worktree):
 *   RUN_REPRO=1 PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=<model> \
 *     node --test test/integration/parallel-spawn-repro.test.ts
 *
 * Config (env):
 *   RUN_REPRO=1          REQUIRED to run at all (spawns real LLM agents)
 *   PI_REPRO_ITERATIONS  batches to run (default 5)
 *   PI_REPRO_BATCH       spawns per batch (default 4, raise to 8 for pressure)
 *   PI_TEST_MODEL        model for the parent pi session AND the children
 *   PI_REPRO_WORKSPACE   workspace for the repro tab (default w0)
 *
 * NOTE parent model: the harness starts the parent with `pi -ne -e <ext>`, and
 * `-ne` disables package discovery — so packages-provided providers (e.g.
 * `cline-*`) are NOT available to the parent even though children see them
 * (the child launch has no `-ne`). Use a built-in provider for PI_TEST_MODEL.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  closeSurface,
  PI_TIMEOUT,
  TEST_MODEL,
  type TestEnv,
} from "./harness.ts";
import { isHerdrAvailable, getHerdrParentPaneId } from "../../pi-extension/subagents/herdr.ts";

// ── Config ──────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.PI_REPRO_ITERATIONS ?? "5");
const BATCH = Number(process.env.PI_REPRO_BATCH ?? "4");
const WORKSPACE = process.env.PI_REPRO_WORKSPACE ?? "w0";
const SPAWN_WAIT_MS = Number(process.env.PI_REPRO_SPAWN_WAIT_MS ?? "45000");
const DELIVERY_WAIT_MS = Number(process.env.PI_REPRO_DELIVERY_WAIT_MS ?? "120000");
const GRACE_MS = Number(process.env.PI_REPRO_GRACE_MS ?? "25000");
const CHILD_MODEL = process.env.PI_REPRO_CHILD_MODEL ?? TEST_MODEL;

const RUN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  ".IDE_Plans/herdr-parallel-spawn-fix/runs",
);

const herdrReady = isHerdrAvailable() && !!getHerdrParentPaneId();
const reproEnabled = process.env.RUN_REPRO === "1";

if (!reproEnabled) {
  console.log("⏭️  RUN_REPRO=1 not set — skipping the F2 repro run (it spawns real LLM agents)");
}

if (!herdrReady) {
  console.log("⚠️  herdr not available (or not inside a herdr pane) — skipping the F2 repro run");
  console.log("   Run inside herdr with PI_SUBAGENT_MUX=herdr.");
}

// ── herdr CLI helpers (read-only) ────────────────────────────────────────────

interface PaneInfo {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  terminal_title?: string;
  agent_session?: { value?: string; agent?: string };
}

function herdrJson(args: string[]): unknown {
  return JSON.parse(
    execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
}

function paneList(): PaneInfo[] {
  const parsed = herdrJson(["pane", "list"]) as { result?: { panes?: PaneInfo[] } };
  return parsed?.result?.panes ?? [];
}

function paneGet(paneId: string): PaneInfo | null {
  try {
    const parsed = herdrJson(["pane", "get", paneId]) as { result?: { pane?: PaneInfo } };
    return parsed?.result?.pane ?? null;
  } catch {
    return null;
  }
}

// ── Task + classification helpers ───────────────────────────────────────────

/** The P7 batch shape: all BATCH subagent calls in ONE parent message. */
function batchTask(id: string, iteration: number, markers: string[]): string {
  const calls = markers
    .map((file, n) =>
      [
        `Call ${n + 1}:`,
        `  name: "R${iteration}${String.fromCharCode(65 + n)}-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${CHILD_MODEL}"`,
        `  task: "Run exactly this bash command: echo 'DONE_${iteration}_${n}' > '${file}'"`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `You must call the subagent tool EXACTLY ${BATCH} times, all in ONE message.`,
    `Make all ${BATCH} calls before waiting for any result — never one at a time.`,
    ``,
    calls,
    ``,
    `Call all ${BATCH} subagent tools NOW, in a single message.`,
    `After all ${BATCH} results have arrived, reply with REPRO_BATCH_${iteration}_COMPLETE.`,
  ].join("\n");
}

/** Screen read that never throws (panes can vanish mid-run). */
function readScreenSafe(paneId: string): string {
  try {
    return readScreen(paneId, 200);
  } catch (error) {
    return `(read failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function classifyPane(
  paneId: string,
  delivered: boolean,
): { verdict: string; evidence: string } {
  const pane = paneGet(paneId);
  const sessionValue = pane?.agent_session?.value ?? null;

  const screen = readScreenSafe(paneId);
  const tail = screen.trimEnd().split("\n").slice(-8).join(" | ").slice(0, 400);

  if (delivered) return { verdict: "launched+delivered", evidence: tail };
  if (sessionValue) return { verdict: "launched-slow", evidence: `agent_session=${sessionValue}` };
  if (/subagent-scripts\/[^\s'"]*\.sh/.test(screen)) return { verdict: "typed-only", evidence: tail };
  if (/[$#»]\s*$/.test(screen.trimEnd())) return { verdict: "bare-shell", evidence: tail };
  return { verdict: "other", evidence: tail };
}

/**
 * Best-effort: the parent session file + how many `subagent` tool calls it made.
 *
 * Children also write cwd-derived sessions, so we scan every session file in
 * the dir and keep the one with the most `subagent` tool calls.
 */
function parentCallEvidence(
  parentPane: string,
  cwd: string,
): { sessionFile: string | null; subagentCalls: number | null } {
  const reported = paneGet(parentPane)?.agent_session?.value ?? null;
  const dir = sessionDirFor(cwd);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { sessionFile: reported, subagentCalls: null };
  }

  let best: { file: string; calls: number; mtime: number } | null = null;
  for (const name of files) {
    const file = join(dir, name);
    let calls = 0;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let entry: {
          message?: { role?: string; content?: Array<{ type?: string; name?: string }> };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.message?.role !== "assistant") continue;
        const content = entry.message.content;
        if (!Array.isArray(content)) continue;
        calls += content.filter((b) => b?.type === "toolCall" && b?.name === "subagent").length;
      }
    } catch {
      continue;
    }
    // Most subagent calls wins; on a tie the newest file is the current run.
    if (!best || calls > best.calls || (calls === best.calls && mtime > best.mtime)) {
      best = { file, calls, mtime };
    }
  }

  if (best && best.calls > 0) return { sessionFile: best.file, subagentCalls: best.calls };
  return { sessionFile: reported ?? best?.file ?? null, subagentCalls: best ? 0 : null };
}

/** pi's session dir for a cwd: `/a/b` → `~/.pi/agent/sessions/--a-b--`. */
function sessionDirFor(cwd: string): string {
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  return join(homedir(), ".pi", "agent", "sessions", `--${slug}--`);
}

// ── The run ─────────────────────────────────────────────────────────────────

if (herdrReady) {
  describe(
    "parallel-spawn-repro [herdr]",
    {
      timeout: PI_TIMEOUT * 15,
      skip: reproEnabled
        ? false
        : "RUN_REPRO=1 not set (this harness spawns real LLM agents)",
    },
    () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    let reproRootPane = "";
    let artifactPath = "";
    const prevHerdrEnv: Record<string, string | undefined> = {};
    const rows: Array<Record<string, unknown>> = [];
    const parentEvidence: Array<Record<string, unknown>> = [];

    const writeArtifact = (): void => {
      if (!artifactPath) return;
      try {
        mkdirSync(RUN_DIR, { recursive: true });
        writeFileSync(
          artifactPath,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              iterations: ITERATIONS,
              batch: BATCH,
              workspace: WORKSPACE,
              parentModel: TEST_MODEL,
              childModel: CHILD_MODEL,
              spawnWaitMs: SPAWN_WAIT_MS,
              deliveryWaitMs: DELIVERY_WAIT_MS,
              graceMs: GRACE_MS,
              lossCount: rows.filter((r) => r.verdict === "bare-shell").length,
              rows,
              parentEvidence,
            },
            null,
            2,
          ) + "\n",
        );
      } catch {
        // Evidence is best-effort; never mask the run result.
      }
    };

    before(async () => {
      prevMux = setBackend("herdr");
      env = createTestEnv("herdr");
      artifactPath = join(
        RUN_DIR,
        `repro-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );

      // A dedicated tab in an isolated workspace — never the user's active one.
      const created = herdrJson([
        "tab",
        "create",
        "--workspace",
        WORKSPACE,
        "--label",
        `pi-repro-${uniqueId()}`,
        "--cwd",
        env.dir,
        "--no-focus",
      ]) as { result?: { root_pane?: { pane_id?: string } } };
      reproRootPane = created?.result?.root_pane?.pane_id ?? "";
      assert.ok(reproRootPane, "expected a root pane for the dedicated repro tab");

      const pane = paneGet(reproRootPane);
      prevHerdrEnv.pane = process.env.HERDR_PANE_ID;
      prevHerdrEnv.tab = process.env.HERDR_TAB_ID;
      prevHerdrEnv.ws = process.env.HERDR_WORKSPACE_ID;
      // Spawns must split from the repro tab, not from the caller's pane.
      process.env.HERDR_PANE_ID = reproRootPane;
      process.env.HERDR_TAB_ID = pane?.tab_id ?? "";
      process.env.HERDR_WORKSPACE_ID = pane?.workspace_id ?? WORKSPACE;
      env.surfaces.push(reproRootPane);

      await sleep(1500);
    });

    after(() => {
      writeArtifact();
      for (const key of ["pane", "tab", "ws"] as const) {
        const value = prevHerdrEnv[key];
        const envKey = { pane: "HERDR_PANE_ID", tab: "HERDR_TAB_ID", ws: "HERDR_WORKSPACE_ID" }[key];
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it(`runs ${ITERATIONS} × ${BATCH}-parallel plugin batches and records the loss matrix`, async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const id = uniqueId();
        const markers = Array.from({ length: BATCH }, (_, n) => {
          const file = `/tmp/pi-repro-${iteration}-${id}-${n}.txt`;
          trackTempFile(env, file);
          rmSync(file, { force: true });
          return file;
        });

        const beforePanes = new Set(paneList().map((p) => p.pane_id));
        const parent = createTrackedSurface(env, `repro-parent-${iteration}-${id}`);
        await sleep(1500);

        /** Panes this run may claim: same workspace, created after the snapshot. */
        const candidates = (): PaneInfo[] =>
          paneList().filter(
            (p) =>
              p.workspace_id === WORKSPACE && !beforePanes.has(p.pane_id) && p.pane_id !== parent,
          );

        const t0 = Date.now();
        startPi(parent, env.dir, batchTask(id, iteration, markers), { model: TEST_MODEL });

        // 1. Wait for the batch's child panes to appear (pane diff), while also
        //    watching whether the parent pi session came up at all. One loop on
        //    purpose: a separate parent-start wait would bias first-seen times.
        const created: string[] = [];
        const firstSeen = new Map<string, number>();
        let parentStartedMs: number | null = null;
        const noteParentStart = (): void => {
          if (parentStartedMs === null && paneGet(parent)?.agent_session?.value) {
            parentStartedMs = Date.now() - t0;
          }
        };
        const spawnDeadline = Date.now() + SPAWN_WAIT_MS;
        while (Date.now() < spawnDeadline && created.length < BATCH) {
          noteParentStart();
          for (const pane of candidates()) {
            if (firstSeen.has(pane.pane_id)) continue;
            firstSeen.set(pane.pane_id, Date.now() - t0);
            created.push(pane.pane_id);
          }
          if (created.length >= BATCH) break;
          await sleep(500);
        }
        noteParentStart();

        // Mid-flight snapshot: titles + agent_session while the batch settles.
        const midFlight = paneList().filter((p) => created.includes(p.pane_id));

        // 2. Wait for the marker files (delivery proof).
        const deliveredAt = new Map<string, number>();
        const deliveryDeadline = t0 + SPAWN_WAIT_MS + DELIVERY_WAIT_MS;
        const readMarkers = (): void => {
          markers.forEach((file, n) => {
            if (deliveredAt.has(file)) return;
            try {
              const content = readFileSync(file, "utf8");
              if (content.includes(`DONE_${iteration}_${n}`)) {
                deliveredAt.set(file, Date.now() - t0);
              }
            } catch {}
          });
        };
        while (Date.now() < deliveryDeadline && deliveredAt.size < BATCH) {
          readMarkers();
          if (deliveredAt.size >= BATCH) break;
          await sleep(1000);
        }

        // 3. Grace window for slow-but-delivered children before classifying.
        if (deliveredAt.size < BATCH) {
          await sleep(GRACE_MS);
          readMarkers();
        }

        // 4. Classify every spawn of this batch.
        const { sessionFile, subagentCalls } = parentCallEvidence(parent, env.dir);
        const parentTab = paneGet(parent)?.tab_id ?? null;
        for (let n = 0; n < BATCH; n++) {
          const markerFile = markers[n];
          const paneId = created[n] ?? null;
          const delivered = deliveredAt.has(markerFile);
          const { verdict, evidence } = paneId
            ? classifyPane(paneId, delivered)
            : { verdict: "no-pane-created", evidence: "fewer panes than spawns" };
          rows.push({
            iteration,
            slot: n,
            paneId,
            firstSeenMs: paneId ? (firstSeen.get(paneId) ?? null) : null,
            deliveredAtMs: delivered ? deliveredAt.get(markerFile) : null,
            markerFile,
            verdict,
            evidence,
            agentSession: paneId ? (paneGet(paneId)?.agent_session?.value ?? null) : null,
            // split (same tab as parent) vs tab-create fallback — both count as launched.
            sameTabAsParent: paneId ? (paneGet(paneId)?.tab_id ?? null) === parentTab : null,
          });
        }

        // 5. Tear this iteration down before the next one. Capture the parent
        //    screen FIRST — on a 0-pane batch it is the only diagnostic.
        const { sessionFile: parentSession, subagentCalls: parentCalls } = {
          sessionFile,
          subagentCalls,
        };
        const parentScreen = readScreenSafe(parent);
        parentEvidence.push({
          iteration,
          parentPane: parent,
          parentModel: TEST_MODEL,
          parentStartedMs,
          parentSession,
          parentSubagentCalls: parentCalls,
          childPanesCreated: created.length,
          screenTail: parentScreen,
        });
        for (const paneId of created) {
          try {
            closeSurface(paneId);
          } catch {}
        }
        try {
          closeSurface(parent);
        } catch {}
        await sleep(1000);
        writeArtifact();

        const lost = rows.filter((r) => r.iteration === iteration && r.verdict === "bare-shell").length;
        console.log(
          `[repro] iteration ${iteration + 1}/${ITERATIONS}: panes=${created.length}/${BATCH} ` +
            `delivered=${deliveredAt.size}/${BATCH} bare-shell=${lost} ` +
            `parentStarted=${parentStartedMs ?? "never"} ` +
            `parentSubagentCalls=${subagentCalls ?? "?"} session=${sessionFile ?? "?"}`,
        );
        if (created.length === 0) {
          console.log(
            `[repro] parent screen tail (no child panes created):\n` +
              parentScreen
                .split("\n")
                .slice(-18)
                .map((line) => `       | ${line}`)
                .join("\n"),
          );
        }
      }

      const lossCount = rows.filter((r) => r.verdict === "bare-shell").length;
      console.log("\n[repro] per-pane matrix:");
      for (const row of rows) {
        console.log(
          `  it=${row.iteration} slot=${row.slot} pane=${row.paneId ?? "-"} ` +
            `firstSeen=${row.firstSeenMs ?? "-"}ms delivered=${row.deliveredAtMs ?? "-"}ms ` +
            `→ ${row.verdict}`,
        );
      }
      console.log(
        `\n[repro] totals: ${rows.length} spawns, ${lossCount} bare-shell (H1 loss), ` +
          `${rows.filter((r) => r.verdict === "typed-only").length} typed-only, ` +
          `${rows.filter((r) => r.verdict === "no-pane-created").length} missing-pane, ` +
          `${rows.filter((r) => r.sameTabAsParent === true).length} via split / ` +
          `${rows.filter((r) => r.sameTabAsParent === false).length} via tab-create fallback.`,
      );
      console.log(`[repro] evidence: ${artifactPath}`);

      // Harness sanity only — loss itself is the evidence, not a failure.
      assert.equal(rows.length, ITERATIONS * BATCH, "every spawn of every iteration must be recorded");
      assert.ok(
        rows.some((r) => r.paneId),
        "expected at least one child pane across the run (herdr split must work)",
      );
    });
  });
}
