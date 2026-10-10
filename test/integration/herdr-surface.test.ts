/**
 * Live contract tests for the herdr backend.
 *
 * These tests drive the REAL herdr CLI against a REAL herdr server: they run
 * only inside a herdr-managed pane (herdr injects `HERDR_ENV=1` /
 * `HERDR_PANE_ID`), and skip with a notice everywhere else — so
 * `npm run test:integration` outside herdr stays non-fatal.
 *
 * Coverage (each case cleans up after itself):
 *   - split creates a real, `--no-focus` pane (no focus steal)
 *   - command delivery through `pane run` (sync + async reads)
 *   - the exit sentinel polled from the screen (pollForExit's slow path)
 *   - Escape delivery on a plain shell pane (pane-level fallback)
 *   - the agent-facade probe (`agent get` → not an agent) and the settle no-op
 *   - closing our own pane, and the parent-pane refusal
 *   - the server is never stopped
 *
 * Local run (isolated, does not touch the user's herdr session):
 *   start a server with a private socket, then run this file inside one of its
 *   panes — see the plan `.IDE_Plans/herdr-backend_plan_20261009_1234_v1.0.md`
 *   §2.8, and the `herdr-contract` CI job, which does exactly this.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getMuxBackend,
  createSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendEscape,
} from "../../pi-extension/subagents/cmux.ts";
import {
  isHerdrAvailable,
  isHerdrAgent,
  waitForHerdrAgentSettle,
  getHerdrParentPaneId,
  getHerdrPaneLayout,
  layoutHerdrColumns,
} from "../../pi-extension/subagents/herdr.ts";

const herdrReady = isHerdrAvailable() && !!getHerdrParentPaneId();

if (!herdrReady) {
  console.log("⚠️  herdr not available (or not inside a herdr pane) — skipping herdr contract tests");
  console.log("   Run inside herdr with PI_SUBAGENT_MUX=herdr to enable these tests.");
}

// ── CLI helpers (assert the herdr contract directly) ─────────────────────────

function herdr(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function paneExists(paneId: string): boolean {
  try {
    herdr(["pane", "get", paneId]);
    return true;
  } catch {
    return false;
  }
}

function focusedPaneId(): string | null {
  try {
    const parsed = JSON.parse(herdr(["pane", "list"]));
    const focused = (parsed as { result?: { panes?: Array<{ pane_id?: string; focused?: boolean }> } })
      ?.result?.panes?.find((pane) => pane.focused);
    return focused?.pane_id ?? null;
  } catch {
    return null;
  }
}

function serverStatus(): string {
  try {
    return herdr(["status", "server"]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const uniqueId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Poll a screen reader until `pattern` shows up or the deadline passes. */
async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readScreenAsync(surface, 200);
      if (pattern.test(last)) return last;
    } catch {
      // Pane may be mid-write; keep polling until the deadline.
    }
    await sleep(1000);
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for ${pattern}.\nLast screen:\n${last.slice(-1200)}`);
}

const created: string[] = [];
const tempDirs: string[] = [];

if (herdrReady) {
  describe("herdr-surface [live contract]", { timeout: 120_000 }, () => {
    let prevMux: string | undefined;

    before(() => {
      prevMux = process.env.PI_SUBAGENT_MUX;
      process.env.PI_SUBAGENT_MUX = "herdr";
      assert.equal(getMuxBackend(), "herdr", "PI_SUBAGENT_MUX=herdr must select the herdr backend");
    });

    after(() => {
      for (const surface of created) {
        try {
          closeSurface(surface);
        } catch {}
      }
      created.length = 0;
      for (const dir of tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      tempDirs.length = 0;
      if (prevMux === undefined) delete process.env.PI_SUBAGENT_MUX;
      else process.env.PI_SUBAGENT_MUX = prevMux;
    });

    it("keeps the parent at ~50% and stacks scouts in one column", async (t) => {
      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");

      // The assertions below describe one whole tab, so they need a pristine
      // one (fresh CI pane: the parent alone). Stray panes -> skip, never fail.
      const before = getHerdrPaneLayout(parent!);
      assert.ok(before, "expected a `pane layout` snapshot");
      if (before.panes.length !== 1) {
        t.skip(`expected a pristine tab, found ${before.panes.length} panes`);
        return;
      }
      const halfTab = before.area.width / 2;
      const focusBefore = focusedPaneId();
      const prevHeight = process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
      const prevWidth = process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
      // Pin both guards so the geometry below does not depend on the runner's
      // tab size (the defaults are unit-tested).
      process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "1";
      process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "1";
      try {
        const stacked: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const surface = createSurface(`p4-layout-${uniqueId()}`);
          created.push(surface);
          stacked.push(surface);
        }

        const geometry = getHerdrPaneLayout(parent!)!;
        const parentRect = geometry.panes.find((entry) => entry.paneId === parent)!.rect;
        assert.ok(
          Math.abs(parentRect.width - halfTab) <= 2,
          `parent must keep ~50% of the tab, got ${parentRect.width} of ${geometry.area.width}`,
        );
        assert.equal(focusedPaneId(), focusBefore, "spawning must not steal focus");

        const columns = layoutHerdrColumns(geometry, parent!);
        assert.equal(columns.length, 1, "four scouts must share a single column");
        assert.deepEqual(
          columns[0].panes.map((entry) => entry.paneId).sort(),
          [...stacked].sort(),
          "the column must hold exactly the spawned panes",
        );
        const heights = columns[0].panes.map((entry) => entry.rect.height);
        assert.ok(
          Math.max(...heights) - Math.min(...heights) <= 2,
          `stacked panes must be near-equal, got ${heights.join(",")}`,
        );
        assert.ok(
          Math.abs(columns[0].width - halfTab) <= 2,
          `the column must hold the other ~50%, got ${columns[0].width} of ${geometry.area.width}`,
        );

        // A column that can no longer hold a legible pane opens a second one,
        // and the parent still keeps its ~50% (the outer-boundary-first rule).
        process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "999";
        const newColumn = createSurface(`p4-col2-${uniqueId()}`);
        created.push(newColumn);
        const widened = getHerdrPaneLayout(parent!)!;
        const wideParent = widened.panes.find((entry) => entry.paneId === parent)!.rect;
        assert.ok(
          Math.abs(wideParent.width - halfTab) <= 2,
          `a new column must not squeeze the parent, got ${wideParent.width} of ${widened.area.width}`,
        );
        const wideColumns = layoutHerdrColumns(widened, parent!);
        assert.equal(wideColumns.length, 2, "the fifth scout must open a second column");
        assert.ok(
          wideColumns.some((column) =>
            column.panes.some((entry) => entry.paneId === newColumn),
          ),
          "the new column must hold the new pane",
        );
        const widths = wideColumns.map((column) => column.width);
        assert.ok(
          Math.max(...widths) - Math.min(...widths) <= 2,
          `columns must be near-equal, got ${widths.join(",")}`,
        );

        // A column too narrow to be usable falls back to a fresh tab and must
        // leave the parent's tab exactly as it was.
        process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "9999";
        const panesBeforeFallback = widened.panes.length;
        const tabPane = createSurface(`p4-tab-${uniqueId()}`);
        assert.equal(paneExists(tabPane), true, "the fallback pane must exist");
        assert.equal(
          getHerdrPaneLayout(parent!)!.panes.length,
          panesBeforeFallback,
          "a width-guard fallback must not touch the parent's tab",
        );
        const tabId = getHerdrPaneLayout(tabPane)?.tabId;
        assert.ok(tabId && tabId !== before.tabId, "the fallback pane must live in a new tab");
        // Close only the tab we just created (never the parent's).
        herdr(["tab", "close", tabId!]);
        await sleep(500);
        assert.equal(paneExists(tabPane), false, "the fallback tab must be cleaned up");
      } finally {
        if (prevHeight === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
        else process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = prevHeight;
        if (prevWidth === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
        else process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = prevWidth;
      }
    });

    it("splits a real pane with --no-focus and does not steal focus", async () => {
      const focusBefore = focusedPaneId();

      const surface = createSurface(`p4-contract-${uniqueId()}`);
      created.push(surface);

      assert.match(surface, /\S+/, "expected a pane id");
      assert.equal(paneExists(surface), true, `expected herdr pane ${surface} to exist`);
      await sleep(1000);

      // --no-focus is the property that makes parallel spawns usable.
      assert.equal(focusedPaneId(), focusBefore, "herdr focus must stay on the parent pane");
    });

    it("delivers a command through pane run and reads it back", async () => {
      const surface = createSurface(`p4-cmd-${uniqueId()}`);
      created.push(surface);
      await sleep(1500);

      const marker = uniqueId();
      sendCommand(surface, `echo "HERDR_CMD_${marker}"`);

      const screen = await waitForScreen(surface, new RegExp(`HERDR_CMD_${marker}`), 20_000);
      assert.ok(screen.includes(`HERDR_CMD_${marker}`));

      // Sync read exercises the same source/parsing path.
      assert.ok(readScreen(surface, 50).includes(`HERDR_CMD_${marker}`));
    });

    it("sees the exit sentinel on the screen (pollForExit's slow path)", async () => {
      const surface = createSurface(`p4-sentinel-${uniqueId()}`);
      created.push(surface);
      await sleep(1500);

      const dir = mkdtempSync(join(tmpdir(), "p4-herdr-"));
      tempDirs.push(dir);
      const script = join(dir, "sentinel.sh");
      writeFileSync(script, `#!/bin/bash\necho HERDR_SENTINEL_START\necho "__SUBAGENT_DONE_7__"\n`);
      chmodSync(script, 0o755);

      sendLongCommand(surface, `bash ${script}`);
      const screen = await waitForScreen(surface, /__SUBAGENT_DONE_(\d+)__/, 25_000);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      assert.ok(match, "expected the sentinel in the pane output");
      assert.equal(Number(match![1]), 7, "the exit code must survive the round-trip");
    });

    it("delivers Escape on a plain shell pane through the pane fallback", async () => {
      const surface = createSurface(`p4-esc-${uniqueId()}`);
      created.push(surface);
      await sleep(1500);

      // The pane is a plain shell, so the backend must not throw and must not
      // depend on the agent facade being available.
      assert.equal(isHerdrAgent(surface), false, "a fresh shell pane is not a herdr agent");
      assert.doesNotThrow(() => sendEscape(surface));
    });

    it("treats the settle accelerator as a no-op for a non-agent pane", () => {
      const surface = created[0];
      assert.ok(surface, "expected a pane created by an earlier case");
      assert.equal(waitForHerdrAgentSettle(surface, { timeoutMs: 250 }), false);
    });

    it("closes its own pane and refuses to close the parent pane", async () => {
      const surface = createSurface(`p4-close-${uniqueId()}`);
      await sleep(1000);
      assert.equal(paneExists(surface), true);

      closeSurface(surface);
      await sleep(500);
      assert.equal(paneExists(surface), false, `expected herdr pane ${surface} to be gone`);

      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");
      assert.throws(() => closeSurface(parent!), /Refusing to close the herdr parent pane/);
    });

    it("never stops the herdr server", () => {
      const status = serverStatus();
      assert.match(status, /running/);
      assert.doesNotMatch(status, /not running/);
    });
  });
}
