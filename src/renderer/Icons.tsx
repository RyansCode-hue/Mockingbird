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
