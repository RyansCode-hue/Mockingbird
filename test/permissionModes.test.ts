import * as fs from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { agentFor, CODEX_EFFORTS, modeArgs, permissionModeRefusal, readRelaunchChange, type LaunchContext } from "../src/main/agents";
import { HELPDESK_MODE_WHY } from "../src/main/helpdesk";
import { PERMISSION_MODES, WIDER_MODES, type PermissionMode } from "../src/shared/permissionModes";
import type { AgentKind, NewSessionRequest, SessionInfo } from "../src/shared/types";
import { PaneRail } from "../src/renderer/TerminalPane";

// TerminalPane and xterm's addons reach for the browser's globals as they load; nothing here draws a terminal
vi.hoisted(() => Object.assign(globalThis, { self: globalThis, window: globalThis }));

const req = (o: Partial<NewSessionRequest> = {}): NewSessionRequest => ({ repoPath: null, useWorktree: false, ...o });
const args = (agent: AgentKind, o: Partial<NewSessionRequest>, ctx: LaunchContext = {}) => agentFor(agent).launchArgs(req({ agent, ...o }), ctx);
/** A Claude launch's flags for its mode: what follows --permission-mode, or none. */
const claudeMode = (a: string[]) => (a.includes("--permission-mode") ? a[a.indexOf("--permission-mode") + 1] : null);
/** The Codex flags a mode adds, as codex-cli 0.156.1's `codex --help` and `codex resume --help` both list them. */
const CODEX_MODE_FLAGS = new Set(["-s", "read-only", "workspace-write", "-a", "on-request", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox"]);
const codexMode = (a: string[]) => a.filter((x) => CODEX_MODE_FLAGS.has(x));
/** A room's sandbox, as each adapter is given it (claudeRoomSandbox.ts, codexRoomSandbox.ts). */
const claudeRoom: LaunchContext = { claudeSettings: { sandbox: { enabled: true, allowUnsandboxedCommands: false } } };
const codexRoom: LaunchContext = { codexPermissions: ['default_permissions="mockingbird-room"', "features.network_proxy=true"] };

describe("a permission mode on each agent's command line", () => {
  it("Claude: --permission-mode by its own name for each, bypass as bypassPermissions, the default as nothing", () => {
    const got = Object.fromEntries(PERMISSION_MODES.map((m) => [m, claudeMode(args("claude", { permissionMode: m }))]));
    expect(got).toEqual({ default: null, plan: "plan", acceptEdits: "acceptEdits", auto: "auto", bypass: "bypassPermissions" });
    expect(claudeMode(args("claude", {}))).toBeNull();
  });

  it("Codex: its sandbox and approval flags for each, none for the default, never the --full-auto it no longer has", () => {
    const got = Object.fromEntries(PERMISSION_MODES.map((m) => [m, codexMode(args("codex", { permissionMode: m }))]));
    expect(got).toEqual({
      default: [],
      plan: ["-s", "read-only"],
      acceptEdits: ["-s", "workspace-write", "-a", "on-request"],
      auto: ["--approve-for-me"],
      bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    });
    for (const m of PERMISSION_MODES) expect(args("codex", { permissionMode: m })).not.toContain("--full-auto");
  });

  it("keeps the mode through a resume, after the resume's own words and before the kickoff prompt", () => {
    const claude = args("claude", { resumeSessionId: "conv-1", permissionMode: "plan", model: "opus", effort: "high" });
    expect(claude.slice(0, 8)).toEqual(["--resume", "conv-1", "--model", "opus", "--effort", "high", "--permission-mode", "plan"]);
    const codex = args("codex", { resumeSessionId: "conv-2", permissionMode: "acceptEdits", initialPrompt: "-go" });
    expect(codex.slice(0, 2)).toEqual(["resume", "conv-2"]);
    expect(codex.slice(2, 6)).toEqual(["-s", "workspace-write", "-a", "on-request"]);
    expect(codex.slice(-2)).toEqual(["--", "-go"]);
    expect(args("codex", { resume: true, permissionMode: "plan" }).slice(0, 4)).toEqual(["resume", "--last", "-s", "read-only"]);
  });

  it("refuses a value that isn't a mode rather than passing it on", () => {
    expect(() => args("claude", { permissionMode: "bypassPermissions" as PermissionMode })).toThrow(/isn't a permission mode/);
    expect(() => modeArgs("codex", "full-auto" as PermissionMode)).toThrow(/isn't a permission mode/);
  });
});

describe("a mode in a team room's sandbox only tightens it", () => {
  it("Claude: Ask as usual and Plan mode keep the room's --settings; accept edits, auto and bypass are refused", () => {
    for (const m of ["default", "plan"] as const) {
      const a = args("claude", { permissionMode: m }, claudeRoom);
      expect(a).toContain("--settings");
      expect(JSON.parse(a[a.indexOf("--settings") + 1]).sandbox).toEqual(claudeRoom.claudeSettings!.sandbox);
      expect(a).toEqual(expect.arrayContaining(["--setting-sources", "user", "--strict-mcp-config"]));
    }
    for (const m of ["acceptEdits", "auto", "bypass"] as const) expect(() => args("claude", { permissionMode: m }, claudeRoom), m).toThrow(/loosen the team room's sandbox/);
  });

  it("Codex: every mode but the default picks Codex's own sandbox, which would replace the room's, so only the default runs there", () => {
    const plain = args("codex", { permissionMode: "default" }, codexRoom);
    expect(plain).toEqual(expect.arrayContaining(["-c", 'default_permissions="mockingbird-room"']));
    expect(codexMode(plain)).toEqual([]);
    for (const m of ["plan", "acceptEdits", "auto", "bypass"] as const) expect(() => args("codex", { permissionMode: m }, codexRoom), m).toThrow(/would replace the team room's/);
  });

  it("outside a room's sandbox (none, or the room's switched off) every mode runs", () => {
    for (const agent of ["claude", "codex"] as const) for (const m of PERMISSION_MODES) expect(permissionModeRefusal(agent, m, { roomSandboxed: false }), `${agent} ${m}`).toBeNull();
  });
});

describe("the Helpdesk tasks workspace's modes", () => {
  it("takes Ask as usual and Plan mode, and nothing wider, refused in main whoever asks", () => {
    for (const m of PERMISSION_MODES) {
      const why = permissionModeRefusal("claude", m, { role: "tasks", roomSandboxed: false });
      expect(why, m).toBe(WIDER_MODES.has(m) ? HELPDESK_MODE_WHY : null);
    }
    expect(() => args("claude", { role: "tasks", permissionMode: "bypass" }, { chrome: true })).toThrow(HELPDESK_MODE_WHY);
    expect(claudeMode(args("claude", { role: "tasks", permissionMode: "plan" }, { chrome: true }))).toBe("plan");
    // an Orchestrator is no Helpdesk
    expect(permissionModeRefusal("claude", "auto", { role: "orchestrator", roomSandboxed: false })).toBeNull();
  });
});

describe("a restart's changes, as main reads them (readRelaunchChange)", () => {
  it("takes a mode, a model and an effort, a null model or effort meaning the agent's default, and nothing else", () => {
    expect(readRelaunchChange(undefined, "claude")).toEqual({});
    expect(readRelaunchChange({ permissionMode: "plan", model: "claude-opus-4-7[1m]", effort: "max", extra: "--dangerously-skip-permissions" }, "claude")).toEqual({ permissionMode: "plan", model: "claude-opus-4-7[1m]", effort: "max" });
    expect(readRelaunchChange({ model: null, effort: null }, "codex")).toEqual({ model: null, effort: null });
    expect(readRelaunchChange({ model: "gpt-5.1-codex", effort: "xhigh" }, "codex")).toEqual({ model: "gpt-5.1-codex", effort: "xhigh" });
  });

  it("refuses what isn't one, saying what would be", () => {
    expect(() => readRelaunchChange("plan", "claude")).toThrow(/a permission mode, a model and an effort/);
    expect(() => readRelaunchChange(["plan"], "claude")).toThrow(/a permission mode, a model and an effort/);
    expect(() => readRelaunchChange({ permissionMode: "bypassPermissions" }, "claude")).toThrow(/isn't a permission mode: Ask as usual, Plan mode/);
    expect(() => readRelaunchChange({ permissionMode: 3 }, "claude")).toThrow(/isn't a permission mode/);
    for (const model of ["", "x".repeat(81), "opus; rm -rf ~", "opus model", "--dangerously-skip-permissions", "-m", 4]) {
      expect(() => readRelaunchChange({ model }, "claude"), String(model)).toThrow(/A model is a name of at most 80/);
    }
    expect(readRelaunchChange({ model: "x".repeat(80) }, "claude").model).toHaveLength(80);
    for (const effort of ["minimal", "MAX", "", 2]) expect(() => readRelaunchChange({ effort }, "claude"), String(effort)).toThrow(/An effort is one of low, medium, high, xhigh, max/);
  });

  it("maps Codex's effort to its reasoning effort by the same name, and refuses Claude's max, which Codex hasn't", () => {
    expect(CODEX_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(() => readRelaunchChange({ effort: "max" }, "codex")).toThrow("Codex has no max reasoning effort: low, medium, high, xhigh");
    expect(args("codex", { effort: "xhigh" })).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="xhigh"']));
  });
});

describe("restarting with changes from the window", () => {
  // index.ts registers it through the take-over guard (takenOverGuard.test.ts reads that from its source)
  it("is one bridge call to main's sessions:relaunchWith, which the preview answers too", () => {
    const preload = fs.readFileSync(new URL("../src/main/preload.ts", import.meta.url), "utf8");
    expect(preload).toMatch(/\brelaunchWith\s*:\s*\(\s*id\s*:\s*string\s*,\s*change\s*:\s*RelaunchChange\s*\)[^=]*=>\s*ipcRenderer\.invoke\(\s*"sessions:relaunchWith"\s*,\s*id\s*,\s*change\s*\)/);
    const stub = fs.readFileSync(new URL("../src/preview/stub.ts", import.meta.url), "utf8");
    expect(stub).toMatch(/^\s*relaunchWith\s*:\s*async\s*\(/m);
  });
});

describe("the workspace's info", () => {
  const session = (o: Partial<SessionInfo>): SessionInfo =>
    ({ id: "s1", title: "a", repoPath: null, cwd: "/Users/you", branch: null, ticketId: null, ticketTitle: null, taskGroup: null, status: "idle", createdAt: Date.now(), kind: "assistant", extraDirs: [], waitingReason: null, waitingSince: null, ...o }) as SessionInfo;
  const rail = (s: SessionInfo) => renderToStaticMarkup(createElement(PaneRail, { session: s, git: null, gitErr: null, pr: null, readPr: () => {} }));

  it("shows the mode in one row, by its label, only when it isn't the default", () => {
    expect(rail(session({ permissionMode: "plan" }))).toContain('<span class="k">Mode</span><span class="v">Plan mode</span>');
    expect(rail(session({ permissionMode: "bypass" }))).toContain('<span class="v">Bypass permissions</span>');
    for (const permissionMode of [undefined, null, "default"] as const) expect(rail(session({ permissionMode }))).not.toContain(">Mode<");
  });
});
