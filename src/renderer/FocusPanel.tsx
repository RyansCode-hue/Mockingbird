import type React from "react";
import type { ToolKind } from "../shared/landscape";
import { CloseIcon } from "./Icons";
import { OVERLAYS } from "./keys";
import { TOOL_NAME } from "./ToolWindow";
import { TOOL_KEYS } from "./workspaceActions";

/**
 * The tools that dock beside a focused workspace, in the side bar's slot between the rail and the workspace, where the
 * area tree shows otherwise: one at a time, the tree included. On the landscape they're tool windows instead.
 */
export type FocusTool = Extract<ToolKind, "files" | "changes" | "run">;
const FOCUS_TOOLS: readonly ToolKind[] = ["files", "changes", "run"];
export const isFocusTool = (t: ToolKind | null): t is FocusTool => !!t && FOCUS_TOOLS.includes(t);

/**
 * A tool docked beside the focused workspace (FocusTool), on the session in front of it: `scope` names it short (its
 * branch), `scopeTip` in full. Esc anywhere in it that nothing inside took hands the keyboard back (`onEscape`); ×
 * closes it, as its rail icon pressed again does.
 */
export function FocusPanel({
  tool,
  scope,
  scopeTip,
  session,
  onClose,
  onEscape,
  onClick,
  children,
}: {
  tool: FocusTool;
  scope: string | null;
  scopeTip?: string;
  /** The session it's on: null while the one in front isn't one of this Mac's. */
  session: string | null;
  onClose: () => void;
  onEscape: () => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  children: React.ReactNode;
}) {
  const keys = TOOL_KEYS[tool];
  return (
    <section
      className="side-tool"
      data-tool={tool}
      data-session={session ?? undefined}
      aria-label={`${TOOL_NAME[tool]}${scopeTip || scope ? ` — ${scopeTip || scope}` : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(OVERLAYS)) return;
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }}
    >
      <div className="side-head">
        <span className="side-title">{TOOL_NAME[tool]}</span>
        {scope && (
          <span className="side-scope" title={scopeTip || scope}>
            {scope}
          </span>
        )}
        <button type="button" className="ls-win-btn side-close" aria-label={`Close ${TOOL_NAME[tool]}`} data-tip={`Close${keys ? ` (${keys})` : ""}`} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="side-tool-body">{children}</div>
    </section>
  );
}
