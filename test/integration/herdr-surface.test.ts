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
 *   - same-tab-only placement: never a new tab, parent stays leftmost at ~50%
 *     (v3.8.3 — see `phase0-evidence.md` §E-5/§E-6)
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

function tabsOfWorkspace(workspaceId: string): string[] {
  try {
    const parsed = JSON.parse(herdr(["tab", "list"])) as {
      result?: { tabs?: Array<{ tab_id?: string; workspace_id?: string }> };
    };
    return (parsed.result?.tabs ?? [])
      .filter((tab) => tab.workspace_id === workspaceId)
      .map((tab) => tab.tab_id ?? "");
  } catch {
    return [];
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

        // A column too narrow for another one must NOT open a tab (v3.8.3):
        // the spawn overflows inside the parent's tab, either by reclaiming a
        // finished pane or by degrading to a shorter split of the column.
        process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "9999";
        process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "9999";
        const panesBeforeOverflow = widened.panes.length;
        const overflow = createSurface(`p4-overflow-${uniqueId()}`);
        created.push(overflow);
        assert.equal(paneExists(overflow), true, "the overflow pane must exist");
        const afterOverflow = getHerdrPaneLayout(parent!)!;
        assert.equal(
          afterOverflow.tabId,
          before.tabId,
          "an overflow must stay in the parent's tab, never a new one",
        );
        assert.equal(
          afterOverflow.panes.length,
          panesBeforeOverflow + 1,
          "the overflow pane must land in the parent's tab",
        );
        assert.equal(
          getHerdrPaneLayout(overflow)?.tabId,
          before.tabId,
          "the overflow pane must never land in a foreign tab",
        );
        const overflowParent = afterOverflow.panes.find(
          (entry) => entry.paneId === parent,
        )!.rect;
        assert.ok(
          Math.abs(overflowParent.width - halfTab) <= 2,
          `overflow must not squeeze the parent, got ${overflowParent.width} of ${afterOverflow.area.width}`,
        );
      } finally {
        if (prevHeight === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
        else process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = prevHeight;
        if (prevWidth === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
        else process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = prevWidth;
      }
    });

    it("never opens a tab, even when both guards say the tab is full (same-tab-only)", async () => {
      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");
      const before = getHerdrPaneLayout(parent!);
      assert.ok(before, "expected a `pane layout` snapshot");
      const focusBefore = focusedPaneId();
      const prevHeight = process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
      const prevWidth = process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
      // Hostile guards: no room to stack, no room for another column. The only
      // legal outcomes are a reclaiming overflow or the loud error - a tab is
      // never one of them.
      process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "9999";
      process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "9999";
      try {
        const spawned: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const surface = createSurface(`p4-notab-${uniqueId()}`);
          created.push(surface);
          spawned.push(surface);
        }

        const geometry = getHerdrPaneLayout(parent!)!;
        assert.equal(geometry.tabId, before.tabId, "the spawns must not move off the parent's tab");
        // The headline guarantee, straight from the CLI: this workspace still
        // owns exactly one tab.
        assert.ok(before.tabId, "expected a tab id in the layout snapshot");
        assert.deepEqual(
          tabsOfWorkspace(before.tabId!.split(":")[0]),
          [before.tabId],
          "herdr must not have gained a tab (same-tab-only)",
        );
        const parentRect = geometry.panes.find((entry) => entry.paneId === parent)!.rect;
        assert.equal(parentRect.x, geometry.area.x, "the parent must stay the leftmost pane");
        assert.ok(
          Math.abs(parentRect.width - geometry.area.width / 2) <= 2,
          `the parent must stay at ~50%, got ${parentRect.width} of ${geometry.area.width}`,
        );
        for (const surface of spawned) {
          assert.equal(
            getHerdrPaneLayout(surface)?.tabId,
            before.tabId,
            `${surface} must live in the parent's tab, never a new one`,
          );
          const rect = geometry.panes.find((entry) => entry.paneId === surface)!.rect;
          assert.ok(
            rect.x >= parentRect.x + parentRect.width - 1,
            `${surface} must sit right of the parent, got x=${rect.x}`,
          );
        }
        assert.equal(focusedPaneId(), focusBefore, "spawning must not steal focus");
      } finally {
        if (prevHeight === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
        else process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = prevHeight;
        if (prevWidth === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
        else process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = prevWidth;
      }
    });

    it("serialises a back-to-back burst without overlapping panes (EC-1)", async () => {
      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");
      const before = getHerdrPaneLayout(parent!);
      assert.ok(before, "expected a `pane layout` snapshot");
      const focusBefore = focusedPaneId();

      // `createSurface` is synchronous, so this is the closest in-process
      // equivalent of two sessions racing: every spawn must re-read the layout,
      // place itself in a free slot and leave the tab consistent.
      const burst: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const surface = createSurface(`p4-burst-${uniqueId()}`);
        created.push(surface);
        burst.push(surface);
      }

      const geometry = getHerdrPaneLayout(parent!)!;
      assert.equal(geometry.tabId, before.tabId, "a burst must not spawn a tab");
      const parentRect = geometry.panes.find((entry) => entry.paneId === parent)!.rect;
      assert.equal(parentRect.x, geometry.area.x, "the parent must stay leftmost");
      assert.ok(
        Math.abs(parentRect.width - geometry.area.width / 2) <= 2,
        `the parent must stay at ~50%, got ${parentRect.width} of ${geometry.area.width}`,
      );

      const rects = burst.map(
        (surface) => geometry.panes.find((entry) => entry.paneId === surface)!.rect,
      );
      for (const rect of rects) {
        assert.ok(
          rect.x >= parentRect.x + parentRect.width - 1,
          `burst pane must sit right of the parent, got x=${rect.x}`,
        );
      }
      // No two panes of the burst may occupy the same slot (the race signature).
      for (let a = 0; a < rects.length; a += 1) {
        for (let b = a + 1; b < rects.length; b += 1) {
          const disjoint =
            rects[a].x + rects[a].width <= rects[b].x + 1 ||
            rects[b].x + rects[b].width <= rects[a].x + 1 ||
            rects[a].y + rects[a].height <= rects[b].y + 1 ||
            rects[b].y + rects[b].height <= rects[a].y + 1;
          assert.ok(disjoint, `burst panes must not overlap: ${JSON.stringify(rects)}`);
        }
      }
      assert.equal(focusedPaneId(), focusBefore, "spawning must not steal focus");
    });

    it("reclaims a finished pane instead of opening a tab (F1a overflow)", async () => {
      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");
      const before = getHerdrPaneLayout(parent!);
      assert.ok(before?.tabId, "expected a `pane layout` snapshot with a tab id");

      // A finished subagent whose pane stayed open: the sentinel is on screen
      // while the process is still alive (a persistent scout pane).
      const finished = createSurface(`p4-finished-${uniqueId()}`);
      created.push(finished);
      await sleep(1500);
      const dir = mkdtempSync(join(tmpdir(), "p4-reclaim-"));
      tempDirs.push(dir);
      const script = join(dir, "finished.sh");
      writeFileSync(script, '#!/bin/bash\necho "__SUBAGENT_DONE_0__"\nsleep 300\n');
      chmodSync(script, 0o755);
      sendLongCommand(finished, `bash ${script}`);
      await waitForScreen(finished, /__SUBAGENT_DONE_0__/, 25_000);
      const panesBefore = getHerdrPaneLayout(parent!)!.panes.length;

      // Hostile guards: no stacking room, no room for another column -> the
      // only in-tab options are reclaim or degrade.
      const prevHeight = process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
      const prevWidth = process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
      process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "9999";
      process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "9999";
      try {
        const spawned = createSurface(`p4-reclaimed-${uniqueId()}`);
        created.push(spawned);
        await sleep(1500);

        assert.equal(paneExists(spawned), true, "the replacement pane must exist");
        assert.equal(
          getHerdrPaneLayout(spawned)?.tabId,
          before.tabId,
          "the replacement must stay in the parent's tab",
        );
        assert.deepEqual(
          tabsOfWorkspace(before.tabId!.split(":")[0]),
          [before.tabId],
          "a reclaim must not create a tab",
        );
        // One pane closed, one pane created: under guards that forbid both
        // stacking and a new column, a net-zero pane count proves the reclaim
        // path ran instead of the degrade path.
        assert.equal(
          getHerdrPaneLayout(parent!)!.panes.length,
          panesBefore,
          "the overflow must have reclaimed a finished pane (one out, one in)",
        );
        const geometry = getHerdrPaneLayout(parent!)!;
        const parentRect = geometry.panes.find((entry) => entry.paneId === parent)!.rect;
        assert.equal(parentRect.x, geometry.area.x, "the parent must stay leftmost");
        assert.ok(
          Math.abs(parentRect.width - geometry.area.width / 2) <= 2,
          `the parent must stay at ~50%, got ${parentRect.width} of ${geometry.area.width}`,
        );
      } finally {
        if (prevHeight === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
        else process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = prevHeight;
        if (prevWidth === undefined) delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
        else process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = prevWidth;
      }
    });

    it("never reclaims a pane whose subagent is still running (EC-3)", async () => {
      const parent = getHerdrParentPaneId();
      assert.ok(parent, "expected HERDR_PANE_ID inside a herdr pane");
      const before = getHerdrPaneLayout(parent!);
      assert.ok(before?.tabId, "expected a `pane layout` snapshot with a tab id");

      const persistent = createSurface(`p4-persistent-${uniqueId()}`);
      created.push(persistent);
      await sleep(1500);
      sendLongCommand(persistent, "while true; do echo PERSISTENT_ALIVE; sleep 5; done");
      await waitForScreen(persistent, /PERSISTENT_ALIVE/, 20_000);

      const prevHeight = process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT;
      const prevWidth = process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH;
      process.env.PI_SUBAGENT_HERDR_MIN_PANE_HEIGHT = "9999";
      process.env.PI_SUBAGENT_HERDR_MIN_COLUMN_WIDTH = "9999";
      try {
        const spawned = createSurface(`p4-live-${uniqueId()}`);
        created.push(spawned);
        await sleep(1500);

        assert.equal(paneExists(spawned), true, "the new pane must exist");
        assert.equal(
          paneExists(persistent),
          true,
          "a running subagent pane must never be reclaimed",
        );
        assert.deepEqual(
          tabsOfWorkspace(before.tabId!.split(":")[0]),
          [before.tabId],
          "the degrade path must not create a tab either",
        );
        const geometry = getHerdrPaneLayout(parent!)!;
        const parentRect = geometry.panes.find((entry) => entry.paneId === parent)!.rect;
        assert.equal(parentRect.x, geometry.area.x, "the parent must stay leftmost");
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
