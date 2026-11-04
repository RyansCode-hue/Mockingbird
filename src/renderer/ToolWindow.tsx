import type React from "react";
import type { ToolKind } from "../shared/landscape";
import { ChatIcon, CloseIcon, FilesIcon, NoteIcon, RunDebugIcon, SearchIcon, SourceControlIcon } from "./Icons";
import { TOOL_KEYS } from "./workspaceActions";

/** What each tool window is called, and its icon (the rail's). */
export const TOOL_NAME: Record<ToolKind, string> = { files: "Files", changes: "Changes", search: "Search", run: "Run & debug", artifacts: "Artifacts", chat: "Chat" };
const TOOL_ICON: Record<ToolKind, () => React.ReactElement> = {
  files: () => <FilesIcon />,
  changes: () => <SourceControlIcon />,
  search: () => <SearchIcon />,
  run: () => <RunDebugIcon />,
  artifacts: () => <NoteIcon />,
  chat: () => <ChatIcon />,
};

/** ⊟: dock it to the window's edge. */
const DockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 8.5h11" />
  </svg>
);
/** ⧉: place it on the landscape again. */
const PlaceIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2.5" y="5.5" width="8" height="8" rx="1.2" />
    <path d="M5.5 5.5V3.7c0-.66.54-1.2 1.2-1.2h6.6c.66 0 1.2.54 1.2 1.2v6.6c0 .66-.54 1.2-1.2 1.2h-2.8" />
  </svg>
);

/**
 * A tool window (design O): one of today's side bar views — Files, Changes, Search, Run & debug, Artifacts, Chat —
 * in a frame that names its tool and its scope (the workspace or the area it works on). Placed on the landscape it's
 * dragged by its head and docks with ⊟; docked at the window's edge it follows the selected workspace and is placed
 * again with ⧉. Zoomed out to cards it's only its head, as a workspace is only its card. What it hosts is unchanged.
 */
export function ToolWindow({
  id,
  tool,
  scope,
  docked,
  compact = false,
  style,
  onDock,
  onPlace,
  onClose,
  children,
}: {
  id: string;
  tool: ToolKind;
  /** The workspace or area it works on, as its title names it; null while there's none (docked, nothing selected). */
  scope: string | null;
  docked: boolean;
  /** Zoomed out to cards: its head alone, its body not drawn. */
  compact?: boolean;
  style?: React.CSSProperties;
  onDock?: () => void;
  onPlace?: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const keys = TOOL_KEYS[tool];
  return (
    <section className={`ls-window ${docked ? "docked" : "placed"} ${compact ? "compact" : ""}`} data-win={id} data-tool={tool} style={style} aria-label={`${TOOL_NAME[tool]}${scope ? ` — ${scope}` : ""}`}>
      <header className="ls-win-head" title={docked ? undefined : "drag to move it · ⊟ docks it to the window's edge"}>
        <span className="ls-win-ico">{TOOL_ICON[tool]()}</span>
        <span className="ls-win-t">{TOOL_NAME[tool]}</span>
        {scope && (
          <span className="ls-win-scope" title={scope}>
            {scope}
          </span>
        )}
        <span className="ls-spacer" />
        {docked && <span className="ls-win-docked">docked</span>}
        {docked
          ? onPlace && (
              <button type="button" className="ls-win-btn" aria-label="Place it on the landscape" data-tip="Place it on the landscape, beside the selected workspace" onClick={onPlace}>
                <PlaceIcon />
              </button>
            )
          : onDock && (
              <button type="button" className="ls-win-btn" aria-label="Dock it" data-tip="Dock it to the window's edge: it follows the selected workspace" onClick={onDock}>
                <DockIcon />
              </button>
            )}
        <button type="button" className="ls-win-btn" aria-label={`Close ${TOOL_NAME[tool]}`} data-tip={`Close${keys ? ` (${keys})` : ""}`} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {!compact && <div className="ls-win-body">{children}</div>}
    </section>
  );
}
