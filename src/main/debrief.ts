import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "./sessions";
import { Store, expandHome } from "./store";
import { writeAdoSnapshot } from "./ado";

/**
 * Writes a passive digest of every live coding session to
 * <workTracker>/session-digests/<date>.md — metadata plus each session's
 * terminal tail, read straight from the in-memory buffers. No session is
 * messaged or interrupted. Returns the file path.
 */
export function writeSessionDigest(sessions: SessionManager, store: Store): string {
  const dir = path.join(expandHome(store.settings.workTrackerPath), "session-digests");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}.md`);
  const entries = sessions.digest();
  const parts = [
    `# Mockingbird session digest — ${date}`,
    `Generated ${new Date().toLocaleTimeString()} · ${entries.length} live session${entries.length === 1 ? "" : "s"}. ` +
      `Passive snapshot of each session's terminal tail — nothing was sent to any session.`,
  ];
  for (const { info, tail } of entries) {
    const started = new Date(info.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    parts.push(
      `\n## ${info.title} — ${info.status}`,
      `ticket: ${info.ticketId ?? "—"} · branch: ${info.branch ?? "—"} · repo: ${info.repoPath ?? info.cwd} · started ${started}`,
      "",
      "```",
      tail || "(no output captured)",
      "```"
    );
  }
  fs.writeFileSync(file, parts.join("\n"));
  return file;
}

/**
 * Debriefs run as interactive claude sessions in the WorkTracker folder,
 * driven by your existing instruction files — flagged `debrief` so they live
 * on the WorkTracker tab instead of the sessions grid.
 */
export function runDebrief(kind: "morning" | "wrapUp", sessions: SessionManager, store: Store): void {
  const wt = expandHome(store.settings.workTrackerPath);
  const file = kind === "morning" ? "instructions/morning.md" : "instructions/wrap-up.md";
  const title = kind === "morning" ? "Morning brief" : "4pm wrap-up";

  const info = sessions.create({
    repoPath: null,
    useWorktree: false,
    taskGroup: "assistant",
    title,
    debrief: true,
  });

  // assemble the kickoff context (session digest + live ADO snapshot), then
  // send once claude has had time to boot — whichever takes longer
  const started = Date.now();
  (async () => {
    let notes = "";

    // wrap-up gets a digest of the whole day's sessions to summarize from
    if (kind === "wrapUp") {
      try {
        const digestFile = writeSessionDigest(sessions, store);
        notes +=
          ` Also read ${digestFile} — a passive snapshot of today's Mockingbird coding sessions ` +
          `(terminal output tails; no session was interrupted). Fold each session's progress into the wrap-up.`;
      } catch (err) {
        console.error("[debrief] session digest failed, continuing without it:", err);
      }
    }

    // both debriefs get live ticket truth via the app's own PAT — so an
    // unavailable ADO connector in Claude Code no longer means stale states
    try {
      const snap = await writeAdoSnapshot(store);
      notes +=
        ` Also read ${snap.file} — a live Azure DevOps snapshot of your ${snap.count} open work item${snap.count === 1 ? "" : "s"} ` +
        `(states, descriptions, recent comments) pulled via the REST API at kickoff. Treat it as the source of ` +
        `truth for ticket state, especially if your ADO connector is unavailable. PR review votes are not in it.`;
    } catch (err) {
      console.error("[debrief] ADO snapshot failed, continuing without it:", err);
    }

    const delay = Math.max(1000, 6000 - (Date.now() - started));
    setTimeout(() => {
      sessions.sendMessage(
        info.id,
        `Read ${wt}/${file} and follow it exactly. Today's date: ${new Date().toDateString()}. ` +
          `I'm at my desk in Mockingbird — ask me your interview questions directly and I'll answer here.` +
          notes
      );
    }, delay);
  })();
}

/** In-app scheduler: fires debriefs at the configured times (weekdays) while the app runs. */
export function startScheduler(sessions: SessionManager, store: Store): void {
  let lastFired: Record<string, string> = {}; // kind -> yyyy-mm-dd

  setInterval(() => {
    const s = store.settings.debriefs;
    if (!s.enabled) return;
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const today = now.toISOString().slice(0, 10);
    for (const [kind, time] of [["morning", s.morning], ["wrapUp", s.wrapUp]] as const) {
      if (hhmm === time && lastFired[kind] !== today) {
        lastFired[kind] = today;
        runDebrief(kind, sessions, store);
      }
    }
  }, 30_000);
}
