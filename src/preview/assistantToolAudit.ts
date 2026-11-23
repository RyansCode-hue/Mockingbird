/**
 * ?assistantToolAudit (with ?motion=off): main's Assistant asking the window to open tool windows (assistant:window
 * openTool, tools/look.ts open_tool) in the UI preview, into <script id="mb-assistant-tool-audit"> for
 * test/uiAssistantTools.test.ts. Once the landscape is up: Changes beside s5, Artifacts in 5102, Files docked, Files
 * beside s5 again while it's docked, and Files beside a session that isn't there. Each step reports the windows it left
 * as the landscape stores them (new ones by id), the landscape changes it asked main for (window.__mbCalls), which
 * session is selected, and what the landscape said.
 */
import type { Landscape, LandscapePatch, LandscapeState, ToolWindow } from "../shared/landscape";
import type { AssistantWindowAction } from "../shared/assistant";

export interface AssistantToolAuditEnv {
  emit: (name: string, ...args: unknown[]) => void;
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stored = async (): Promise<Landscape> => (await (window as unknown as { mb: { landscapeGet: () => Promise<LandscapeState> } }).mb.landscapeGet()).landscape;

export function runAssistantToolAudit(env: AssistantToolAuditEnv): void {
  const out: Record<string, unknown> = {};
  const write = () => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-assistant-tool-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  /** Main's event `a`, and what it left once it settled. */
  const step = async (a: AssistantWindowAction) => {
    const before = new Set(Object.keys((await stored()).tools));
    const mark = env.calls.length;
    env.emit("onAssistantWindow", a);
    await sleep(700);
    const tools = (await stored()).tools;
    const opened: ToolWindow[] = Object.entries(tools)
      .filter(([id]) => !before.has(id))
      .map(([, w]) => ({ tool: w.tool, docked: w.docked, ...(w.session ? { session: w.session } : {}), ...(w.area !== undefined ? { area: w.area } : {}) }));
    return {
      opened,
      placed: Object.values(tools).filter((w) => !w.docked && w.placement).length,
      updates: env.calls.slice(mark).filter((c) => c.fn === "landscapeUpdate").map((c) => Object.keys(c.args[0] as LandscapePatch)),
      selected: document.querySelector<HTMLElement>(".ls-node.selected")?.dataset.front ?? null,
      said: document.querySelector(".ls-note")?.textContent ?? null,
      drawn: document.querySelectorAll(".ls-window").length,
    };
  };
  env.waitFor(".ls-viewport", () => {
    void (async () => {
      try {
        await sleep(400);
        out.changes = await step({ kind: "openTool", tool: "changes", session: "s5" });
        out.artifacts = await step({ kind: "openTool", tool: "artifacts", area: "5102" });
        out.docked = await step({ kind: "openTool", tool: "files", docked: true });
        out.filesWhileDocked = await step({ kind: "openTool", tool: "files", session: "s5" });
        out.gone = await step({ kind: "openTool", tool: "files", session: "nope" });
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
      write();
    })();
  });
}
