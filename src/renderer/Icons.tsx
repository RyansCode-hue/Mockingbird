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
