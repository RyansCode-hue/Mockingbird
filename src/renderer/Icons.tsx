import React from "react";

// 16-unit line icons drawn in currentColor, so they follow the button's text
// color through hover, active, and both themes.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="ico"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A window split into one tall pane and two stacked panes. */
export const LayoutIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M7 2.75v10.5M7 8h7.25" />
  </Icon>
);

/** Two overlapping documents with folded corners. */
export const FilesIcon = () => (
  <Icon>
    <path d="M6 4.25V3a1 1 0 0 1 1-1h3.75L13.5 4.75V10.5a1 1 0 0 1-1 1h-1.75" />
    <path d="M3.5 4.5h4.25l2.75 2.75V13a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" />
    <path d="M7.75 4.5v2.75h2.75" />
  </Icon>
);

/** A folder; open while its workspace is in the grid. */
export const FolderIcon = ({ open }: { open?: boolean }) => (
  <Icon>
    {open ? (
      <path d="M2 12.5V4.25A1.25 1.25 0 0 1 3.25 3h3l1.5 1.75h4.5A1.25 1.25 0 0 1 13.5 6v1M2 12.5l1.6-4.6a1 1 0 0 1 .95-.65h9.6a.75.75 0 0 1 .7 1l-1.45 4.25H2z" />
    ) : (
      <path d="M2 4.25A1.25 1.25 0 0 1 3.25 3h3l1.5 1.75h5A1.25 1.25 0 0 1 14 6v6a1.25 1.25 0 0 1-1.25 1.25h-9.5A1.25 1.25 0 0 1 2 12z" />
    )}
  </Icon>
);

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Icon>
    <path d={open ? "M4.5 6.5 8 10l3.5-3.5" : "M6.5 4.5 10 8l-3.5 3.5"} />
  </Icon>
);

/** A window with a panel on its right — shows/hides a side panel. */
export const PanelRightIcon = ({ open }: { open?: boolean }) => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M10 2.75v10.5" />
    {open && <path d="M11.6 5.5h1.1M11.6 7.5h1.1M11.6 9.5h1.1" />}
  </Icon>
);

/** An eye — reads the code. */
export const ReadIcon = () => (
  <Icon>
    <path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </Icon>
);

/** A terminal prompt — runs commands. */
export const RunIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75M8.25 10h3.25" />
  </Icon>
);

/** Stacked containers — uses Docker. */
export const DockerIcon = () => (
  <Icon>
    <rect x="2" y="7.5" width="3.5" height="3" rx=".5" />
    <rect x="6.25" y="7.5" width="3.5" height="3" rx=".5" />
    <rect x="10.5" y="7.5" width="3.5" height="3" rx=".5" />
    <rect x="6.25" y="3.75" width="3.5" height="3" rx=".5" />
    <path d="M1.75 12.5h12.5" />
  </Icon>
);

/** Two stacked terminal windows: the Sessions view. */
export const SessionsIcon = () => (
  <Icon>
    <rect x="1.75" y="2.25" width="10" height="8" rx="1.5" />
    <path d="M4.25 7.75v4a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-5a1.5 1.5 0 0 0-1.5-1.5h-1M4 5l1.5 1.25L4 7.5M7 7.5h2" />
  </Icon>
);

/** A branch leaving a line and merging back: Source Control. */
export const SourceControlIcon = () => (
  <Icon>
    <circle cx="4.5" cy="3.25" r="1.5" />
    <circle cx="4.5" cy="12.75" r="1.5" />
    <circle cx="11.5" cy="5.25" r="1.5" />
    <path d="M4.5 4.75v6.5M11.5 6.75c0 3-7 2-7 4.5" />
  </Icon>
);

/** A magnifying glass: Search. */
export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25l3.5 3.5" />
  </Icon>
);

/** A four-pointed sparkle: written by a model. */
export const SparkleIcon = () => (
  <Icon>
    <path d="M8 1.75c.35 2.9 1.35 3.9 4.25 4.25C9.35 6.35 8.35 7.35 8 10.25 7.65 7.35 6.65 6.35 3.75 6M8 1.75C7.65 4.65 6.65 5.65 3.75 6" />
    <path d="M12.5 10.25c.15 1.2.55 1.6 1.75 1.75-1.2.15-1.6.55-1.75 1.75-.15-1.2-.55-1.6-1.75-1.75 1.2-.15 1.6-.55 1.75-1.75z" />
  </Icon>
);

/** A page with a folded corner: a file with no type badge. */
export const FileIcon = () => (
  <Icon>
    <path d="M4.25 1.75h4.5l3 3v8.5a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1z" />
    <path d="M8.75 1.75v3h3" />
  </Icon>
);

/** A play triangle with a small bug: Run and Debug. */
export const RunDebugIcon = () => (
  <Icon>
    <path d="M3.5 2.75v10.5L9 10" />
    <path d="M3.5 2.75 11.5 8" />
    <ellipse cx="12" cy="11.5" rx="2" ry="2.5" />
    <path d="M10 10.25H9M15 10.25h-1M10 12.75H9M15 12.75h-1M12 9v5" />
  </Icon>
);

/** A bug: run under the debugger. */
export const BugIcon = () => (
  <Icon>
    <ellipse cx="8" cy="9.25" rx="3.25" ry="4" />
    <path d="M6 5.75a2 2 0 0 1 4 0M8 5.25v8M4.75 8H2.5M13.5 8h-2.25M4.9 11.25 3 12.5M11.1 11.25 13 12.5M5 6.5 3.25 5.25M11 6.5l1.75-1.25" />
  </Icon>
);

/** A push pin, angled: the pane stays on screen when the grid switches groups. */
export const PinIcon = () => (
  <Icon>
    <path d="M9.5 2.25l4.25 4.25-1.75.5-2.5 2.5.25 2.75-1 1-2.5-2.5-3.5 3.5M5.25 8.25l-2.5-2.5 1-1 2.75.25 2.5-2.5.5-1.75" />
  </Icon>
);

/** A bell: this session notifies. */
export const BellIcon = () => (
  <Icon>
    <path d="M4.25 11V7.25a3.75 3.75 0 0 1 7.5 0V11l1 1.25H3.25z" />
    <path d="M6.75 13.75a1.25 1.25 0 0 0 2.5 0" />
  </Icon>
);

/** A struck-through bell: this session's notifications are muted. */
export const BellOffIcon = () => (
  <Icon>
    <path d="M4.25 11V7.25a3.75 3.75 0 0 1 6.1-2.9M11.75 7.5V11l1 1.25H5.5" />
    <path d="M6.75 13.75a1.25 1.25 0 0 0 2.5 0M2.5 2.5l11 11" />
  </Icon>
);

/** A circular arrow: an update of Mockingbird is available, building or installing. */
export const UpdateIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2.5v2.75h-2.75" />
  </Icon>
);

/** A page with lines and a pencil: a room note anyone in the room edits. */
export const NoteIcon = () => (
  <Icon>
    <path d="M10.5 13.25h-6a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V7" />
    <path d="M5.5 5h5M5.5 7.25h4M5.5 9.5h2" />
    <path d="M9.25 13.5l.4-1.6 3.1-3.1a.85.85 0 0 1 1.2 1.2l-3.1 3.1z" />
  </Icon>
);

/** Two chain links: a link to a page. */
export const LinkIcon = () => (
  <Icon>
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.55.05l2-2a2.5 2.5 0 0 0-3.55-3.55l-.75.75" />
    <path d="M9.25 6.75a2.5 2.5 0 0 0-3.55-.05l-2 2a2.5 2.5 0 0 0 3.55 3.55l.75-.75" />
  </Icon>
);

/** Angle brackets on a page: a file in a repo, at a commit. */
export const RepoFileIcon = () => (
  <Icon>
    <path d="M4.25 1.75h4.5l3 3v8.5a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1z" />
    <path d="M6.5 8.25 5.25 9.5l1.25 1.25M9.5 8.25l1.25 1.25L9.5 10.75" />
  </Icon>
);

/** A padlock: agents can't read this. */
export const LockIcon = () => (
  <Icon>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
    <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
  </Icon>
);

/** A board with three columns of cards (Tabler's layout-kanban, a column wider): a room's House board. */
export const KanbanIcon = () => (
  <Icon>
    <path d="M1.75 2.5h3.5M6.25 2.5h3.5M10.75 2.5h3.5" />
    <rect x="1.75" y="4.5" width="3.5" height="9" rx="1" />
    <rect x="6.25" y="4.5" width="3.5" height="5.5" rx="1" />
    <rect x="10.75" y="4.5" width="3.5" height="7.25" rx="1" />
  </Icon>
);

/** A plus: add or start something new. */
export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

/** An arrow curling back: undo. */
export const UndoIcon = () => (
  <Icon>
    <path d="M5.5 3.75 2.75 6.5 5.5 9.25" />
    <path d="M2.75 6.5h6.5a3.75 3.75 0 0 1 0 7.5H7.5" />
  </Icon>
);

/** Two arrows passing: hand the task to the other agent. */
export const HandoffIcon = () => (
  <Icon>
    <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8" />
    <path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
  </Icon>
);

/** Four corners pointing out: fill the grid. */
export const ExpandIcon = () => (
  <Icon>
    <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />
  </Icon>
);

/** Four corners pointing in: back to the grid. */
export const ShrinkIcon = () => (
  <Icon>
    <path d="M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25" />
  </Icon>
);

/** A bar: hide (it keeps running). */
export const MinusIcon = () => (
  <Icon>
    <path d="M3.5 8h9" />
  </Icon>
);

/** A cross: close. */
export const CloseIcon = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

/** A pencil: rename. */
export const PencilIcon = () => (
  <Icon>
    <path d="M10.25 2.75l3 3-7.5 7.5-3.5.5.5-3.5z" />
    <path d="M8.75 4.25l3 3" />
  </Icon>
);

/** An arrow into a folder: move to a group. */
export const MoveIcon = () => (
  <Icon>
    <path d="M2 6.5V4.25A1.25 1.25 0 0 1 3.25 3h3l1.5 1.75h5A1.25 1.25 0 0 1 14 6v6a1.25 1.25 0 0 1-1.25 1.25H8" />
    <path d="M1.75 10.5h5M5 8.5l2 2-2 2" />
  </Icon>
);

/** Three dots: more actions. */
export const MoreIcon = () => (
  <Icon>
    <circle cx="3.5" cy="8" r=".6" />
    <circle cx="8" cy="8" r=".6" />
    <circle cx="12.5" cy="8" r=".6" />
  </Icon>
);

/** An arrow into a laptop: continue a teammate's session on this Mac. */
export const TakeOverIcon = () => (
  <Icon>
    <path d="M3.25 10.75V5a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1v5.75" />
    <path d="M1.75 12.75h12.5" />
    <path d="M8 1.25v6M6 5.25l2 2 2-2" />
  </Icon>
);

/** Arrows around a frame: redraw the screen. */
export const RepaintIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 0 1-8.54 3.54M3 8a5 5 0 0 1 8.54-3.54" />
    <path d="M11.75 2.25v2.5h-2.5M4.25 13.75v-2.5h2.5" />
  </Icon>
);

/** A speech bubble with lines: a room's chat. */
export const ChatIcon = () => (
  <Icon>
    <path d="M2.25 3.75a1.5 1.5 0 0 1 1.5-1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.25l-3 2.5v-2.5h-.5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M5.25 5.75h5.5M5.25 7.75h3.5" />
  </Icon>
);

/** A person with a plus: invite a teammate. */
export const InviteIcon = () => (
  <Icon>
    <circle cx="6.5" cy="5.25" r="2.5" />
    <path d="M1.75 13.5a4.75 4.75 0 0 1 9.5 0" />
    <path d="M12.75 5.5v4M10.75 7.5h4" />
  </Icon>
);

/** A speech bubble with a question: ask for a status report. */
export const AskIcon = () => (
  <Icon>
    <path d="M2.25 3.75a1.5 1.5 0 0 1 1.5-1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.25l-3 2.5v-2.5h-.5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M6.6 5a1.45 1.45 0 1 1 1.9 1.4c-.35.15-.5.4-.5.75v.2M8 9h.01" />
  </Icon>
);

/** An arrow up out of a tray: share a group as a room. */
export const ShareIcon = () => (
  <Icon>
    <path d="M8 10V2.5M5.25 5.25 8 2.5l2.75 2.75" />
    <path d="M3 9.25v3a1.25 1.25 0 0 0 1.25 1.25h7.5A1.25 1.25 0 0 0 13 12.25v-3" />
  </Icon>
);

/** A grid of four squares: show in the grid. */
export const GridIcon = () => (
  <Icon>
    <rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1" />
    <rect x="9" y="2.25" width="4.75" height="4.75" rx="1" />
    <rect x="2.25" y="9" width="4.75" height="4.75" rx="1" />
    <rect x="9" y="9" width="4.75" height="4.75" rx="1" />
  </Icon>
);

/** An arrow pointing left: back. */
export const BackIcon = () => (
  <Icon>
    <path d="M9.5 3.5 5 8l4.5 4.5" />
  </Icon>
);

/** A hash: mention a room artifact in a message. */
export const HashIcon = () => (
  <Icon>
    <path d="M6.25 2.5 5 13.5M11 2.5 9.75 13.5M2.75 6h11M2.25 10h11" />
  </Icon>
);

/** An arrow down onto a tray: download. */
export const DownloadIcon = () => (
  <Icon>
    <path d="M8 2.5V10M5.25 7.25 8 10l2.75-2.75" />
    <path d="M3 9.25v3a1.25 1.25 0 0 0 1.25 1.25h7.5A1.25 1.25 0 0 0 13 12.25v-3" />
  </Icon>
);
