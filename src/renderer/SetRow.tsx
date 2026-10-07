import React from "react";

/** One setting: name and a short note on the left, its control on the right. */
export function SetRow({ title, note, children }: { title: React.ReactNode; note?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {note && <div className="set-row-note">{note}</div>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}
