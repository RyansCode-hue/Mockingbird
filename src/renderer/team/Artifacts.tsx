import React, { useCallback, useEffect, useRef, useState } from "react";
import { isErr, splitGroupKey, type SessionInfo } from "../../shared/types";
import { plural } from "../../shared/format";
import { baseName } from "../../shared/paths";
import type { TeamRoomSummary } from "../../shared/team/types";
import {
  MAX_ARTIFACT_FILE,
  MAX_ARTIFACT_NAME,
  MAX_NOTE_TEXT,
  linkLabel,
  type AddFilesResult,
  type ArtifactAdded,
  type ArtifactSummary,
  type RepoResolution,
  type RoomArtifactsView,
} from "../../shared/team/artifacts";
import { usePersisted } from "../prefs";
import { MenuButton } from "../Menu";
import { Modal } from "../Modal";
import { RenameDialog } from "../Dialogs";
import { QuickOpen } from "../QuickOpen";
import { ChevronIcon, LockIcon } from "../Icons";
import { settled } from "../settled";
import { addedLine, artifactMeta, parseLines, repoDefaultName, transferLine } from "./artifactModel";
import type { InlineContext } from "./markdownView";
import { ArtifactGlyph, ArtifactViewer, NoteBody, WritePreview } from "./ArtifactViewer";

/**
 * A team room's artifacts in the Team tab (docs/team-rooms.md → Artifacts):
 * the collapsible "Artifacts · N" section under the room's header — one row
 * per file, note, repo file or link, + Add, drops onto the tab and pasted
 * screenshots — and the chips chat messages show for #[name] references.
 */

const failed = (what: string, error: string) => `${what}: ${error}`;

/** A room's artifacts, kept current. */
export function useArtifacts(roomId: string) {
  const [view, setView] = useState<RoomArtifactsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    settled<RoomArtifactsView | { error: string }>(window.mb.artifactsList(roomId)).then((r) => {
      if (isErr(r)) return setError(failed("Couldn't read the room's artifacts", r.error));
      setView(r);
      setError(null);
    });
  }, [roomId]);
  useEffect(() => {
    load();
    // a download reports progress often: one read per burst
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.mb.onArtifactsChanged((id: string) => {
      if (id !== roomId || timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 100);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  return { view, error, reload: load };
}

type Refused = AddFilesResult["refused"];

/**
 * Adding files to a room — picked, dropped or pasted — with the secret check:
 * a file named like a secret (or holding a private key) is added only once
 * the person says so. What wasn't added, and why, stays on the shelf's
 * error line; warnings (a commit not pushed yet) on its note line.
 */
export function useArtifactActions(roomId: string) {
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ refused: Refused; answer: (yes: boolean) => void } | null>(null);
  const ask = (refused: Refused) => new Promise<boolean>((answer) => setConfirm({ refused, answer }));

  /** Shows what wasn't added and why, and any warnings about what was. */
  const finish = (...results: AddFilesResult[]) => {
    const added = results.flatMap((r) => r.added);
    const refused = results.flatMap((r) => r.refused);
    setError(refused.length ? `Not added — ${refused.map((r) => `${r.name}: ${r.reason}`).join("; ")}` : null);
    setNotes(added.flatMap((a) => a.warnings.map((w) => `${a.name}: ${w}`)));
    return added;
  };

  /** One call's result, with its secret-named files asked about and added again when the person agrees. */
  const settle = async (r: AddFilesResult | { error: string }, what: string, again: (names: string[]) => Promise<AddFilesResult | { error: string }>): Promise<AddFilesResult> => {
    if (isErr(r)) return { added: [], refused: [{ name: what, reason: r.error }] };
    const added = [...r.added];
    const refused = r.refused.filter((x) => x.needsConfirm !== "secret");
    const secret = r.refused.filter((x) => x.needsConfirm === "secret");
    if (secret.length && (await ask(secret))) {
      const r2 = await again(secret.map((s) => s.name));
      if (isErr(r2)) refused.push(...secret.map((s) => ({ name: s.name, reason: r2.error })));
      else {
        added.push(...r2.added);
        refused.push(...r2.refused);
      }
    }
    return { added, refused };
  };

  const addPaths = async (paths: string[]): Promise<AddFilesResult> => {
    if (!paths.length) return { added: [], refused: [] };
    const r = await settled<AddFilesResult | { error: string }>(window.mb.artifactsAddFiles(roomId, paths));
    return settle(r, plural(paths.length, "file"), (names) => settled(window.mb.artifactsAddFiles(roomId, paths.filter((p) => names.includes(baseName(p))), true)));
  };

  /** Files without a path on disk (a pasted screenshot, an image dragged from a browser): their bytes. */
  const addBlobs = async (files: File[]): Promise<AddFilesResult> => {
    if (!files.length) return { added: [], refused: [] };
    const all: AddFilesResult = { added: [], refused: [] };
    const bytesOf = new Map<string, Uint8Array>();
    for (const f of files) {
      const name = f.name || "Pasted file";
      if (f.size > MAX_ARTIFACT_FILE) {
        all.refused.push({ name, reason: `over the ${MAX_ARTIFACT_FILE / 1024 / 1024} MB limit` });
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      bytesOf.set(name, bytes);
      const r = await settled<AddFilesResult | { error: string }>(window.mb.artifactsAddBytes(roomId, name, bytes));
      if (isErr(r)) all.refused.push({ name, reason: r.error });
      else {
        all.added.push(...r.added);
        all.refused.push(...r.refused);
      }
    }
    return settle(all, plural(files.length, "file"), async (names) => {
      const again: AddFilesResult = { added: [], refused: [] };
      for (const name of names) {
        const r = await settled<AddFilesResult | { error: string }>(window.mb.artifactsAddBytes(roomId, name, bytesOf.get(name)!, true));
        if (isErr(r)) again.refused.push({ name, reason: r.error });
        else {
          again.added.push(...r.added);
          again.refused.push(...r.refused);
        }
      }
      return again;
    });
  };

  /** Dropped or pasted files: by path when they have one, else by their bytes. Resolves to what was added. */
  const addFiles = async (files: File[]): Promise<ArtifactAdded[]> => {
    const withPath = files.map((f) => ({ f, path: window.mb.getFilePath(f) || null }));
    const byPath = await addPaths(withPath.filter((x) => x.path).map((x) => x.path!));
    const byBytes = await addBlobs(withPath.filter((x) => !x.path).map((x) => x.f));
    return finish(byPath, byBytes);
  };

  const pick = async () => {
    const paths = await settled<string[] | null | { error: string }>(window.mb.artifactsPickFiles());
    if (isErr(paths)) return setError(failed("Couldn't open the file picker", paths.error));
    if (paths?.length) finish(await addPaths(paths));
  };

  const dialog = confirm && (
    <Modal className="modal close-dlg" onClose={() => (confirm.answer(false), setConfirm(null))}>
      <h3>{confirm.refused.length === 1 ? `“${confirm.refused[0].name}” looks like a secret` : `${confirm.refused.length} files look like secrets`}</h3>
      <div className="sub-h">
        {confirm.refused.map((r) => (
          <div key={r.name}>
            <b>{r.name}</b> — {r.reason}
          </div>
        ))}
        <div className="art-confirm-note">Everyone in the room gets a copy. Agents in the room never read it, whatever it's renamed to.</div>
      </div>
      <div className="row">
        <button className="outline" onClick={() => (confirm.answer(false), setConfirm(null))}>
          Don't add
        </button>
        <button className="primary" onClick={() => (confirm.answer(true), setConfirm(null))}>
          Add anyway
        </button>
      </div>
    </Modal>
  );

  return {
    addFiles,
    pick,
    error,
    notes,
    fail: setError,
    note: (text: string) => setNotes([text]),
    dismiss: () => {
      setError(null);
      setNotes([]);
    },
    dialog,
  };
}

export type ArtifactActions = ReturnType<typeof useArtifactActions>;

/**
 * Files dragged onto the Team tab: the overlay while they're over it, and
 * the drop. Only drags carrying files count (not the app's own drags).
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  return {
    over,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      },
    },
  };
}

/** An artifact named in a chat message: its current name, opening it; a removed one says so. */
export function ArtifactChip({ item, label, onOpen }: { item: ArtifactSummary | undefined; label: string; onOpen: (id: string) => void }) {
  if (!item) return <span className="rc-artifact gone" title="Removed from the room">{label} (removed)</span>;
  return (
    <button className="rc-artifact" title={`${item.name} — ${artifactMeta(item, "")}`} onClick={() => onOpen(item.id)}>
      <ArtifactGlyph a={item} />
      <span className="rc-artifact-name">{item.name}</span>
    </button>
  );
}

/** The sessions a repo file can be picked from: the focused one when it's in a repo, else the room group's. */
export function repoSessionsFor(sessions: SessionInfo[], focusedSessionId: string | null, groupKey: string | null | undefined): SessionInfo[] {
  const inRepo = (s: SessionInfo) => !!s.repoPath && s.kind !== "assistant";
  const focused = sessions.find((s) => s.id === focusedSessionId);
  if (focused && inRepo(focused)) return [focused];
  return sessions.filter((s) => inRepo(s) && !!groupKey && !!s.taskGroup && splitGroupKey(s.taskGroup).top === groupKey);
}

type Adding =
  | { step: "note" }
  | { step: "link" }
  | { step: "repo-session"; options: SessionInfo[] }
  | { step: "repo-file"; session: SessionInfo }
  | { step: "repo-form"; session: SessionInfo; path: string; line: number | null };

export function ArtifactShelf({
  room,
  self,
  arts,
  actions,
  viewing,
  setViewing,
  onMention,
  ctx,
  sessions,
  focusedSessionId,
  onOpenRepoFile,
}: {
  room: TeamRoomSummary;
  self: string;
  arts: ReturnType<typeof useArtifacts>;
  actions: ArtifactActions;
  viewing: string | null;
  setViewing: (id: string | null) => void;
  onMention: (a: ArtifactSummary) => void;
  ctx: InlineContext;
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  onOpenRepoFile: (open: NonNullable<RepoResolution["open"]>) => void;
}) {
  const [open, setOpen] = usePersisted("mb.roomArtifacts.open", true);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [renaming, setRenaming] = useState<ArtifactSummary | null>(null);
  const [removing, setRemoving] = useState<ArtifactSummary | null>(null);
  const view = arts.view;
  const items = [...(view?.items ?? [])].sort((a, b) => b.addedAt - a.addedAt);

  const call = async (what: string, run: () => Promise<unknown>) => {
    const r = await settled(run());
    if (isErr(r)) {
      actions.fail(failed(`Couldn't ${what}`, r.error));
      return false;
    }
    return true;
  };
  const addRepoFile = () => {
    const options = repoSessionsFor(sessions, focusedSessionId, room.groupKey);
    if (!options.length) return actions.fail("No session on this Mac is in a repo — open one in this room's group, then reference a file from it.");
    setAdding(options.length === 1 ? { step: "repo-file", session: options[0] } : { step: "repo-session", options });
  };

  return (
    <div className={`art-shelf ${open ? "open" : ""}`}>
      <div className="art-shelf-head">
        <button className="art-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the room's artifacts" : "Show the room's artifacts"}>
          <ChevronIcon open={open} />
          Artifacts{view ? ` · ${items.length}` : ""}
        </button>
        <MenuButton
          className="rc-new-session"
          label="+ Add"
          title="Share a file, a note, a repo file or a link with the room"
          items={[
            { key: "file", label: "File…", onPick: () => actions.pick() },
            { key: "note", label: "Note", onPick: () => setAdding({ step: "note" }) },
            { key: "repo", label: "Repo file…", onPick: addRepoFile },
            { key: "link", label: "Link", onPick: () => setAdding({ step: "link" }) },
          ]}
        />
      </div>
      {(actions.error || arts.error) && (
        <div className="art-line err">
          <span>{actions.error ?? arts.error}</span>
          {actions.error && (
            <button className="link" onClick={actions.dismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {actions.notes.length > 0 && (
        <div className="art-line warn">
          <span>{actions.notes.join(" · ")}</span>
          <button className="link" onClick={actions.dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {open && view && (
        <>
          {view.problems.map((p) => (
            <div key={p} className="art-line warn">
              {p}
            </div>
          ))}
          {view.notices.length > 0 && (
            <div className="team-notices art-notices">
              {view.notices.map((n) => (
                <div key={n.id} className="team-notice warn">
                  <div className="team-notice-text">{n.text}</div>
                  {n.artifact && view.items.some((i) => i.id === n.artifact) && (
                    <button className="link" onClick={() => setViewing(n.artifact!)}>
                      Open
                    </button>
                  )}
                  <button className="link" onClick={() => call("dismiss the notice", () => window.mb.artifactsDismissNotice(room.id, n.id))}>
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          )}
          {items.length === 0 ? (
            <div className="art-empty">Share files, screenshots, notes, repo files and links with the room: + Add, drop files here, or paste a screenshot into the message box.</div>
          ) : (
            <div className="art-list">
              {items.map((a) => (
                <ArtifactRow
                  key={a.id}
                  a={a}
                  self={self}
                  onOpen={() => setViewing(a.id)}
                  onMention={() => onMention(a)}
                  onRename={() => setRenaming(a)}
                  onRemove={() => setRemoving(a)}
                  onDownload={() => call("download it", () => window.mb.artifactsDownload(room.id, a.id))}
                />
              ))}
            </div>
          )}
        </>
      )}

      {viewing && (
        <ArtifactViewer
          key={viewing}
          roomId={room.id}
          self={self}
          item={view?.items.find((i) => i.id === viewing)}
          ctx={ctx}
          focusedSessionId={focusedSessionId}
          onClose={() => setViewing(null)}
          onOpen={setViewing}
          onOpenRepoFile={onOpenRepoFile}
          onRename={setRenaming}
          onRemove={setRemoving}
          onMention={onMention}
        />
      )}
      {renaming && (
        <RenameDialog
          title={`Rename “${renaming.name}”`}
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            const id = renaming.id;
            setRenaming(null);
            await call("rename it", () => window.mb.artifactsRename(room.id, id, name.slice(0, MAX_ARTIFACT_NAME)));
          }}
        />
      )}
      {removing && (
        <Modal className="modal close-dlg" onClose={() => setRemoving(null)}>
          <h3>Remove “{removing.name}”?</h3>
          <div className="sub-h">It's removed for everyone in the room, and each teammate's copy is deleted. Messages that named it say “(removed)”.</div>
          <div className="row">
            <button className="outline" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={async () => {
                const id = removing.id;
                setRemoving(null);
                if (await call("remove it", () => window.mb.artifactsRemove(room.id, id))) if (viewing === id) setViewing(null);
              }}
            >
              Remove for everyone
            </button>
          </div>
        </Modal>
      )}
      {adding?.step === "note" && <NewNoteDialog roomId={room.id} ctx={ctx} onClose={() => setAdding(null)} onAdded={(a) => (setAdding(null), setViewing(a.id))} />}
      {adding?.step === "link" && <LinkDialog roomId={room.id} onClose={() => setAdding(null)} onAdded={() => setAdding(null)} />}
      {adding?.step === "repo-session" && (
        <Modal className="modal close-dlg" onClose={() => setAdding(null)}>
          <h3>Reference a file from which session?</h3>
          <div className="sub-h">The reference is to the file at the session's current commit; teammates open it in their own clone.</div>
          <div className="art-pick">
            {adding.options.map((s) => (
              <button key={s.id} className="art-pick-row" onClick={() => setAdding({ step: "repo-file", session: s })}>
                <span className="art-pick-title">{s.title}</span>
                <span className="art-quiet">
                  {baseName(s.cwd)}
                  {s.branch && s.branch !== baseName(s.cwd) ? ` · ${s.branch}` : ""}
                </span>
              </button>
            ))}
          </div>
          <div className="row">
            <button className="outline" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {adding?.step === "repo-file" && (
        <QuickOpen
          session={adding.session}
          placeholder={`A file in ${baseName(adding.session.cwd)} to share with the room — name:line for a line`}
          onClose={() => setAdding((a) => (a?.step === "repo-file" ? null : a))}
          onOpen={(path, line) => setAdding({ step: "repo-form", session: adding.session, path, line })}
        />
      )}
      {adding?.step === "repo-form" && <RepoFormDialog roomId={room.id} session={adding.session} path={adding.path} line={adding.line} onClose={() => setAdding(null)} onAdded={(a) => (setAdding(null), a.warnings.length && actions.note(a.warnings.join(" · ")))} />}
    </div>
  );
}

function ArtifactRow({
  a,
  self,
  onOpen,
  onMention,
  onRename,
  onRemove,
  onDownload,
}: {
  a: ArtifactSummary;
  self: string;
  onOpen: () => void;
  onMention: () => void;
  onRename: () => void;
  onRemove: () => void;
  onDownload: () => void;
}) {
  const x = a.kind === "file" ? transferLine(a) : null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className="art-row"
      role="button"
      tabIndex={0}
      title={addedLine(a, self)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <ArtifactGlyph a={a} />
      <div className="art-main">
        <div className="art-name-line">
          <span className="art-name">{a.name}</span>
          {a.agentsBlocked && (
            <span className="art-lock" title={`Agents in the room can't read this: ${a.agentsBlocked}`}>
              <LockIcon />
            </span>
          )}
          <span className="art-acts">
            <button className="icon" title="Mention it in a message (#)" onClick={stop(onMention)}>
              #
            </button>
            <button className="icon" title="Rename" onClick={stop(onRename)}>
              ✎
            </button>
            <button className="icon danger" title="Remove for everyone in the room" onClick={stop(onRemove)}>
              ✕
            </button>
          </span>
        </div>
        <div className="art-meta">{artifactMeta(a, self)}</div>
        {x && (
          <div className={`art-xfer ${a.local?.state === "failed" ? "bad" : a.local?.state === "waiting" ? "wait" : ""}`} title={x.tip}>
            <span className="art-xfer-text">{x.text}</span>
            {x.action && (
              <button className="link" onClick={stop(onDownload)}>
                {x.action}
              </button>
            )}
          </div>
        )}
        {x?.pct !== undefined && (
          <div className="art-bar">
            <span style={{ width: `${x.pct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function NewNoteDialog({ roomId, ctx, onClose, onAdded }: { roomId: string; ctx: InlineContext; onClose: () => void; onAdded: (a: ArtifactAdded) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!name.trim() && text.length <= MAX_NOTE_TEXT && !busy;
  const add = async () => {
    if (!ok) return;
    setBusy(true);
    const r = await settled<ArtifactAdded | { error: string }>(window.mb.artifactsAddNote(roomId, name.trim().slice(0, MAX_ARTIFACT_NAME), text));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    onAdded(r);
  };
  return (
    <Modal
      className="modal art-dlg art-new-note"
      onClose={() => (!text.trim() || window.confirm("Discard this note?")) && onClose()}
      closeOnBackdrop={false}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
          e.preventDefault();
          add();
        }
      }}
    >
      <h3>New note</h3>
      <div className="sub-h">Markdown everyone in the room can read and edit — specs, decisions, checklists. Room agents read it too.</div>
      <label>Name</label>
      <input type="text" autoFocus value={name} maxLength={MAX_ARTIFACT_NAME} placeholder="Last-org spec" onChange={(e) => setName(e.target.value)} />
      <div className="art-note-bar">
        <label>Text</label>
        <WritePreview preview={preview} setPreview={setPreview} />
      </div>
      <div className="art-body art-v-edit">
        <NoteBody text={text} setText={setText} preview={preview} ctx={ctx} autoFocus={false} />
      </div>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <span className={`foot-hint art-quiet ${text.length > MAX_NOTE_TEXT ? "err-inline" : ""}`}>
          {text.length.toLocaleString()} / {MAX_NOTE_TEXT.toLocaleString()} characters
        </span>
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={!ok} onClick={add}>
          Add note <span className="kbd">⌘↵</span>
        </button>
      </div>
    </Modal>
  );
}

function LinkDialog({ roomId, onClose, onAdded }: { roomId: string; onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [titled, setTitled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = url.trim() ? linkLabel(url.trim()) : null;
  const ok = !!parsed && !!title.trim() && !busy;
  const add = async () => {
    if (!ok) return;
    setBusy(true);
    const r = await settled(window.mb.artifactsAddLink(roomId, url.trim(), title.trim().slice(0, MAX_ARTIFACT_NAME)));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    onAdded();
  };
  return (
    <Modal className="modal close-dlg art-link-dlg" onClose={onClose}>
      <h3>Add a link</h3>
      <div className="sub-h">A page the room should have at hand — a ticket, a PR, a design. https only.</div>
      <label>Link</label>
      <input
        type="text"
        autoFocus
        value={url}
        placeholder="https://dev.azure.com/…/_workitems/edit/5110"
        onChange={(e) => {
          const next = e.target.value;
          setUrl(next);
          const l = linkLabel(next.trim());
          if (!titled) setTitle(l ? l.label ?? l.host : "");
        }}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      {url.trim() && !parsed && <div className="err">That isn't an https link.</div>}
      <label>Title</label>
      <input
        type="text"
        value={title}
        maxLength={MAX_ARTIFACT_NAME}
        onChange={(e) => {
          setTitle(e.target.value);
          setTitled(true);
        }}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={!ok} onClick={add}>
          Add link
        </button>
      </div>
    </Modal>
  );
}

function RepoFormDialog({
  roomId,
  session,
  path,
  line,
  onClose,
  onAdded,
}: {
  roomId: string;
  session: SessionInfo;
  path: string;
  line: number | null;
  onClose: () => void;
  onAdded: (a: ArtifactAdded) => void;
}) {
  const [lines, setLines] = useState(line ? String(line) : "");
  const [name, setName] = useState(() => repoDefaultName(path, line ? [line, line] : null));
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseLines(lines);
  const ok = !("error" in parsed) && !!name.trim() && !busy;
  const add = async () => {
    if (!ok || "error" in parsed) return;
    setBusy(true);
    const r = await settled<ArtifactAdded | { error: string }>(window.mb.artifactsAddRepo(roomId, { sessionId: session.id, path, lines: parsed.lines, name: name.trim().slice(0, MAX_ARTIFACT_NAME) }));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    onAdded(r);
  };
  return (
    <Modal className="modal close-dlg art-repo-dlg" onClose={onClose}>
      <h3>Reference a repo file</h3>
      <div className="sub-h">
        <span className="tk-path">{path}</span> in {baseName(session.cwd)}, at its current commit. Teammates open it in their own clone of the repo — nothing is copied.
      </div>
      <label>Lines (optional)</label>
      <input
        type="text"
        autoFocus
        value={lines}
        placeholder="12 or 12–40"
        onChange={(e) => {
          setLines(e.target.value);
          const p = parseLines(e.target.value);
          if (!named && !("error" in p)) setName(repoDefaultName(path, p.lines));
        }}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      {"error" in parsed && <div className="err">{parsed.error}</div>}
      <label>Name</label>
      <input
        type="text"
        value={name}
        maxLength={MAX_ARTIFACT_NAME}
        onChange={(e) => {
          setName(e.target.value);
          setNamed(true);
        }}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={!ok} onClick={add}>
          Add reference
        </button>
      </div>
    </Modal>
  );
}
