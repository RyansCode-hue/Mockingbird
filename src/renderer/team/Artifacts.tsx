import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isErr, type SessionInfo } from "../../shared/types";
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
  type SecretConfirm,
} from "../../shared/team/artifacts";
import { usePersisted } from "../prefs";
import { MenuButton } from "../Menu";
import { ActionBar, pickActions, tidyMenu, useContextMenu } from "../ContextMenu";
import { CloseIcon, DownloadIcon, HashIcon, PencilIcon, ReadIcon } from "../Icons";
import { Modal } from "../Modal";
import { RenameDialog } from "../Dialogs";
import { QuickOpen } from "../QuickOpen";
import { ChevronIcon, LockIcon } from "../Icons";
import { settled } from "../settled";
import { addedLine, artifactKind, artifactMeta, parseLines, REMOVE_ARTIFACT_NOTE, REMOVE_LOCAL_ARTIFACT_NOTE, repoDefaultName, repoSessionsFor, transferLine } from "./artifactModel";
import { areaShelf } from "../../shared/areaArtifacts";
import { LinkIcon } from "../Icons";
import type { InlineContext } from "./markdownView";
import { ArtifactGlyph, ArtifactViewer, NoteBody, WritePreview } from "./ArtifactViewer";

/**
 * A team room's artifacts in the Team tab (docs/team-rooms.md → Artifacts):
 * the collapsible "Artifacts · N" section under the room's header — one row
 * per file, note, repo file or link, + Add, drops onto the tab and pasted
 * screenshots — and the chips chat messages show for #[name] references.
 *
 * The same shelf is an area's Artifacts window on the landscape
 * (docs/landscape.md, Tools): a room's area shows the room's, any other area
 * its own on this Mac (`local`), by a shelf id (shared/areaArtifacts.ts) the
 * same calls take.
 */

/** Whose artifacts a shelf shows: a room's (its id), or an area's on this Mac (`area:<key>`). */
export interface ShelfInfo {
  id: string;
  /** The group whose sessions a repo file is picked from. */
  groupKey: string;
  /** An area's on this Mac: nobody else has them. */
  local: boolean;
}

/** The shelf area `key` shows: its room's when it's shared as one, else its own on this Mac. */
export const shelfOfArea = (key: string, room: TeamRoomSummary | null): ShelfInfo => (room ? { id: room.id, groupKey: key, local: false } : { id: areaShelf(key), groupKey: key, local: true });

const failed = (what: string, error: string) => `${what}: ${error}`;

/** A room's artifacts, kept current. */
export function useArtifacts(roomId: string) {
  const [view, setView] = useState<RoomArtifactsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    settled<RoomArtifactsView | { error: string }>(window.mb.artifactsList(roomId)).then((r) => {
      if (isErr(r)) return setError(failed(`Couldn't read the ${roomId.startsWith("area:") ? "area" : "room"}'s artifacts`, r.error));
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
export function useArtifactActions(roomId: string, local = false) {
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
      const bytes = await f.arrayBuffer().then(
        (b) => new Uint8Array(b),
        (e: unknown) => {
          all.refused.push({ name, reason: `couldn't be read: ${e instanceof Error ? e.message : String(e)}` });
          return null;
        }
      );
      if (!bytes) continue;
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
        <div className="art-confirm-note">{local ? "It stays on this Mac. Agents never read it, whatever it's renamed to." : "Everyone in the room gets a copy. Agents in the room never read it, whatever it's renamed to."}</div>
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

type Adding =
  | { step: "note" }
  | { step: "link" }
  | { step: "repo-session"; options: SessionInfo[] }
  | { step: "repo-file"; session: SessionInfo }
  | { step: "repo-form"; session: SessionInfo; path: string; line: number | null };

export function ArtifactShelf({
  shelf,
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
  inWindow = false,
  onPlace,
  placed,
}: {
  shelf: ShelfInfo;
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
  /** In a tool window: always open, its list taking the window's height. */
  inWindow?: boolean;
  /** Place one on the landscape as a card in its area. */
  onPlace?: (a: ArtifactSummary) => void;
  /** The artifacts with a card on the landscape. */
  placed?: ReadonlySet<string>;
}) {
  const [openPref, setOpen] = usePersisted("mb.roomArtifacts.open", true);
  const open = inWindow || openPref;
  const { local } = shelf;
  const where = local ? "the area" : "the room";
  const [adding, setAdding] = useState<Adding | null>(null);
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
  const edits = useArtifactEdits(shelf, call, (id) => viewing === id && setViewing(null));
  const { setRenaming, setRemoving } = edits;
  const addRepoFile = () => {
    const options = repoSessionsFor(sessions, focusedSessionId, shelf.groupKey);
    if (!options.length) return actions.fail(`No session on this Mac is in a repo — open one in this ${local ? "area" : "room's group"}, then reference a file from it.`);
    setAdding(options.length === 1 ? { step: "repo-file", session: options[0] } : { step: "repo-session", options });
  };

  return (
    <div className={`art-shelf ${open ? "open" : ""} ${inWindow ? "in-window" : ""}`}>
      <div className="art-shelf-head">
        {inWindow ? (
          <span className="art-toggle art-count">
            {local ? "On this Mac" : "Shared with the room"}
            {view ? ` · ${items.length}` : ""}
          </span>
        ) : (
          <button className="art-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the room's artifacts" : "Show the room's artifacts"}>
            <ChevronIcon open={open} />
            Artifacts{view ? ` · ${items.length}` : ""}
          </button>
        )}
        <MenuButton
          className="rc-new-session"
          label="+ Add"
          title={local ? "Keep a file, a note, a repo file or a link in this area" : "Share a file, a note, a repo file or a link with the room"}
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
                  <button className="link" onClick={() => call("dismiss the notice", () => window.mb.artifactsDismissNotice(shelf.id, n.id))}>
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          )}
          {items.length === 0 ? (
            <div className="art-empty">
              {local
                ? "Keep files, screenshots, notes, repo files and links in this area, for you and its agents: + Add, or drop files here. They stay on this Mac."
                : "Share files, screenshots, notes, repo files and links with the room: + Add, drop files here, or paste a screenshot into the message box."}
            </div>
          ) : (
            <div className="art-list">
              {items.map((a) => (
                <ArtifactRow
                  key={a.id}
                  a={a}
                  self={self}
                  local={local}
                  placed={!!placed?.has(a.id)}
                  onOpen={() => setViewing(a.id)}
                  onMention={() => onMention(a)}
                  onRename={() => setRenaming(a)}
                  onRemove={() => setRemoving(a)}
                  onPlace={onPlace && (() => onPlace(a))}
                  onDownload={() => call("download it", () => window.mb.artifactsDownload(shelf.id, a.id))}
                />
              ))}
            </div>
          )}
        </>
      )}

      {viewing && (
        <ArtifactViewer
          key={viewing}
          roomId={shelf.id}
          local={local}
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
      {edits.dialogs}
      {adding?.step === "note" && <NewNoteDialog roomId={shelf.id} local={local} ctx={ctx} onClose={() => setAdding(null)} onAdded={(a) => (setAdding(null), setViewing(a.id))} />}
      {adding?.step === "link" && <LinkDialog roomId={shelf.id} local={local} onClose={() => setAdding(null)} onAdded={() => setAdding(null)} />}
      {adding?.step === "repo-session" && (
        <Modal className="modal close-dlg" onClose={() => setAdding(null)}>
          <h3>Reference a file from which session?</h3>
          <div className="sub-h">The reference is to the file at the session's current commit{local ? "." : "; teammates open it in their own clone."}</div>
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
          placeholder={`A file in ${baseName(adding.session.cwd)} to ${local ? "keep in the area" : "share with the room"} — name:line for a line`}
          onClose={() => setAdding((a) => (a?.step === "repo-file" ? null : a))}
          onOpen={(path, line) => setAdding({ step: "repo-form", session: adding.session, path, line })}
        />
      )}
      {adding?.step === "repo-form" && <RepoFormDialog roomId={shelf.id} local={local} session={adding.session} path={adding.path} line={adding.line} onClose={() => setAdding(null)} onAdded={(a) => (setAdding(null), a.warnings.length && actions.note(a.warnings.join(" · ")))} />}
    </div>
  );
}

/** Renaming and removing an artifact: the dialogs, and what opens them. `onRemoved` hears of one gone. */
function useArtifactEdits(shelf: ShelfInfo, call: (what: string, run: () => Promise<unknown>) => Promise<boolean>, onRemoved: (id: string) => void) {
  const [renaming, setRenaming] = useState<ArtifactSummary | null>(null);
  const [removing, setRemoving] = useState<ArtifactSummary | null>(null);
  const dialogs = (
    <>
      {renaming && (
        <RenameDialog
          title={`Rename “${renaming.name}”`}
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            const id = renaming.id;
            setRenaming(null);
            await call("rename it", () => window.mb.artifactsRename(shelf.id, id, name));
          }}
        />
      )}
      {removing && (
        <Modal className="modal close-dlg" onClose={() => setRemoving(null)}>
          <h3>Remove “{removing.name}”?</h3>
          <div className="sub-h">{shelf.local ? REMOVE_LOCAL_ARTIFACT_NOTE : REMOVE_ARTIFACT_NOTE}</div>
          <div className="row">
            <button className="outline" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={async () => {
                const id = removing.id;
                setRemoving(null);
                if (await call("remove it", () => window.mb.artifactsRemove(shelf.id, id))) onRemoved(id);
              }}
            >
              {shelf.local ? "Remove" : "Remove for everyone"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  return { setRenaming, setRemoving, dialogs };
}

/** What a landscape's artifacts surfaces need from their owner (main.tsx). */
export interface ArtifactSurfaceProps {
  shelf: ShelfInfo;
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  onOpenRepoFile: (open: NonNullable<RepoResolution["open"]>) => void;
  /** Mention it to the selected workspace: its reference typed into its prompt. */
  onMention: (a: ArtifactSummary) => void;
}

/** An area's Artifacts window on the landscape (docs/landscape.md, Tools): its shelf, kept open, files dropped on it added. */
export function ArtifactsWindow({ onPlace, placed, ...p }: ArtifactSurfaceProps & { onPlace: (a: ArtifactSummary) => void; placed: ReadonlySet<string> }) {
  const arts = useArtifacts(p.shelf.id);
  const actions = useArtifactActions(p.shelf.id, p.shelf.local);
  const [viewing, setViewing] = useState<string | null>(null);
  const drop = useFileDrop((files) => void actions.addFiles(files));
  const ctx = useMemo<InlineContext>(() => ({ artifact: (id, label, key) => <ArtifactChip key={key} item={arts.view?.items.find((a) => a.id === id)} label={label} onOpen={setViewing} /> }), [arts.view]);
  return (
    <div className={`art-window ${drop.over ? "drop-on" : ""}`} {...drop.handlers}>
      <ArtifactShelf
        shelf={p.shelf}
        self={arts.view?.self ?? ""}
        arts={arts}
        actions={actions}
        viewing={viewing}
        setViewing={setViewing}
        onMention={p.onMention}
        ctx={ctx}
        sessions={p.sessions}
        focusedSessionId={p.focusedSessionId}
        onOpenRepoFile={p.onOpenRepoFile}
        inWindow
        onPlace={onPlace}
        placed={placed}
      />
      {actions.dialog}
    </div>
  );
}

/**
 * An artifact's card on the landscape (design O), placed from its area's Artifacts window: its kind, name and who
 * added it when, with Open and Mention; right-click for those, Rename, Remove, and taking the card off. One whose
 * artifact was removed says so, and offers only taking it off.
 */
export function ArtifactCardFace({ artifactId, onRemoveCard, ...p }: ArtifactSurfaceProps & { artifactId: string; onRemoveCard: () => void }) {
  const arts = useArtifacts(p.shelf.id);
  const a = arts.view?.items.find((x) => x.id === artifactId);
  // the artifact its viewer shows: the card's, or one the viewer opens from it (a note saved as a copy, the original)
  const [viewing, setViewing] = useState<string | null>(null);
  const shown = viewing ? arts.view?.items.find((x) => x.id === viewing) : undefined;
  const [error, setError] = useState<string | null>(null);
  const call = async (what: string, run: () => Promise<unknown>) => {
    const r = await settled(run());
    if (isErr(r)) setError(failed(`Couldn't ${what}`, r.error));
    return !isErr(r);
  };
  const edits = useArtifactEdits(p.shelf, call, () => setViewing(null));
  const menu = useContextMenu(a?.name ?? "Artifact card");
  const acts = tidyMenu([
    a && { key: "open", label: "Open", icon: <ReadIcon />, onPick: () => setViewing(a.id) },
    a && { key: "mention", label: "Mention", menuLabel: "Mention to the selected workspace", icon: <HashIcon />, onPick: () => p.onMention(a) },
    a && { key: "link", label: "Link", menuLabel: "Link to a workspace… (coming)", icon: <LinkIcon />, disabled: true, title: "Linking it to a workspace comes with context links in a later version", onPick: () => {} },
    a && { key: "rename", label: "Rename", menuLabel: "Rename…", icon: <PencilIcon />, onPick: () => edits.setRenaming(a) },
    "-",
    { key: "uncard", label: "Take off", menuLabel: "Take the card off the landscape", title: "The artifact stays in the area's Artifacts", onPick: onRemoveCard },
    a && { key: "remove", label: "Remove", menuLabel: p.shelf.local ? "Remove the artifact…" : "Remove the artifact for everyone…", icon: <CloseIcon />, danger: true, onPick: () => edits.setRemoving(a) },
  ]);
  const self = arts.view?.self ?? "";
  return (
    <div
      className={`acard ${a ? "" : "gone"}`}
      title={a ? `${a.name} — double-click to open it, right-click for more` : undefined}
      {...menu.bind(acts)}
      onDoubleClick={() => a && setViewing(a.id)}
    >
      <div className="acard-head">
        {a && <ArtifactGlyph a={a} />}
        <span className="acard-name">{a ? a.name : arts.view ? "Removed" : arts.error ? "Couldn't read it" : "Reading…"}</span>
        {a?.agentsBlocked && (
          <span className="art-lock" title={`Agents can't read this: ${a.agentsBlocked}`}>
            <LockIcon />
          </span>
        )}
      </div>
      <div className={`acard-meta ${error || (!a && arts.error) ? "bad" : ""}`}>{error ?? (a ? artifactMeta(a, self) : arts.error ?? (arts.view ? "This artifact isn't in the area any more" : ""))}</div>
      {/* zoomed out, its kind under its name in place of the meta line */}
      {a && <div className="acard-kind">{artifactKind(a)}</div>}
      <div className="acard-acts">
        {a ? (
          <>
            <button type="button" className="outline" onClick={() => setViewing(a.id)}>
              Open
            </button>
            <button type="button" className="outline" onClick={() => p.onMention(a)}>
              Mention
            </button>
          </>
        ) : (
          arts.view && (
            <button type="button" className="outline" onClick={onRemoveCard}>
              Take the card off
            </button>
          )
        )}
      </div>
      {shown && (
        <ArtifactViewer
          roomId={p.shelf.id}
          local={p.shelf.local}
          self={self}
          item={shown}
          ctx={{}}
          focusedSessionId={p.focusedSessionId}
          onClose={() => setViewing(null)}
          onOpen={setViewing}
          onOpenRepoFile={p.onOpenRepoFile}
          onRename={edits.setRenaming}
          onRemove={edits.setRemoving}
          onMention={p.onMention}
        />
      )}
      {edits.dialogs}
      {menu.menu}
    </div>
  );
}

/** A card whose shelf is gone (its room was left): why, and taking it off. */
export function ArtifactCardGone({ why, onRemoveCard }: { why: string; onRemoveCard: () => void }) {
  return (
    <div className="acard gone">
      <div className="acard-head">
        <span className="acard-name">Not here any more</span>
      </div>
      <div className="acard-meta bad">{why}</div>
      <div className="acard-acts">
        <button type="button" className="outline" onClick={onRemoveCard}>
          Take the card off
        </button>
      </div>
    </div>
  );
}

/** How many artifacts a shelf has, kept current: an Artifacts window's count zoomed out. */
export function ArtifactsCount({ shelf }: { shelf: string }) {
  const arts = useArtifacts(shelf);
  if (arts.error) return <span className="bad" title={arts.error}>!</span>;
  return <>{arts.view ? arts.view.items.length : "…"}</>;
}

/**
 * Sharing an area as a room (ShareRoomDialog): its artifacts on this Mac offered to the room too, once it exists.
 * Nothing secret goes (main keeps it back and says so); they all stay on this Mac as well. Nothing shows while the
 * area has none. `onShared` gets each copied artifact's id in the room (its cards move to the copies).
 */
export function ShareAreaArtifacts({ areaKey, roomId, onShared }: { areaKey: string; roomId: string; onShared: (ids: Record<string, string>) => void }) {
  const arts = useArtifacts(areaShelf(areaKey));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ shared: number; refused: { name: string; reason: string }[] } | { error: string } | null>(null);
  const n = arts.view?.items.length ?? 0;
  if (arts.error) return <div className="err">{arts.error}</div>;
  if (!n) return null;
  return (
    <div className="art-share-offer">
      {done && !isErr(done) ? (
        <div className={done.refused.length ? "warn" : "art-quiet"}>
          {plural(done.shared, "artifact")} shared with the room.
          {done.refused.length > 0 && ` Not shared — ${done.refused.map((r) => `${r.name}: ${r.reason}`).join("; ")}`}
        </div>
      ) : (
        <>
          <span>
            This area keeps {plural(n, "artifact")} on this Mac. Share {n === 1 ? "it" : "them"} with the room too? Teammates get a copy; nothing secret is sent.
          </span>
          <button
            className="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await settled<{ shared: number; refused: { name: string; reason: string }[]; ids: Record<string, string> } | { error: string }>(
                window.mb.artifactsShareArea(areaKey, roomId),
                "Couldn't share the area's artifacts",
              );
              setDone(r);
              setBusy(false);
              if (!isErr(r)) onShared(r.ids);
            }}
          >
            {busy ? "Sharing…" : `Share ${plural(n, "artifact")}`}
          </button>
        </>
      )}
      {done && isErr(done) && <div className="err">{done.error}</div>}
    </div>
  );
}

function ArtifactRow({
  a,
  self,
  local,
  placed,
  onOpen,
  onMention,
  onRename,
  onRemove,
  onPlace,
  onDownload,
}: {
  a: ArtifactSummary;
  self: string;
  local: boolean;
  /** It has a card on the landscape. */
  placed: boolean;
  onOpen: () => void;
  onMention: () => void;
  onRename: () => void;
  onRemove: () => void;
  onPlace?: () => void;
  onDownload: () => void;
}) {
  const x = a.kind === "file" ? transferLine(a) : null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const menu = useContextMenu(a.name);
  const acts = tidyMenu([
    { key: "open", label: "Open", icon: <ReadIcon />, onPick: onOpen },
    onPlace
      ? { key: "mention", label: "Mention", menuLabel: "Mention to the selected workspace", icon: <HashIcon />, title: "Type #[name](artifact:…) into the selected workspace's prompt: its agent reads it with its artifact tools", onPick: onMention }
      : { key: "mention", label: "Mention", menuLabel: "Mention in a message (#)", icon: <HashIcon />, title: "Mention it in a message (#)", onPick: onMention },
    !!onPlace && { key: "place", label: "Place", menuLabel: placed ? "Place another card on the landscape" : "Place on the landscape", title: "A card for it in the area, that opens or mentions it", onPick: onPlace },
    !!onPlace && { key: "link", label: "Link", menuLabel: "Link to a workspace… (coming)", icon: <LinkIcon />, disabled: true, title: "Linking it to a workspace, so its agent always has it, comes with context links in a later version", onPick: () => {} },
    { key: "rename", label: "Rename", menuLabel: "Rename…", icon: <PencilIcon />, onPick: onRename },
    !!x?.action && { key: "download", label: x.action, icon: <DownloadIcon />, title: x.tip, onPick: onDownload },
    "-",
    local
      ? { key: "remove", label: "Remove", menuLabel: "Remove…", icon: <CloseIcon />, danger: true, title: "Remove it from this area", onPick: onRemove }
      : { key: "remove", label: "Remove", menuLabel: "Remove for everyone…", icon: <CloseIcon />, danger: true, title: "Remove for everyone in the room", onPick: onRemove },
  ]);
  return (
    <div
      className="art-row"
      role="button"
      tabIndex={0}
      title={`${addedLine(a, self)} · right-click for more`}
      {...menu.bind(acts)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
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
            <span className="art-lock" title={`${local ? "Agents" : "Agents in the room"} can't read this: ${a.agentsBlocked}`}>
              <LockIcon />
            </span>
          )}
          {placed && <span className="art-placed">on the landscape</span>}
          <ActionBar className="art-acts" actions={pickActions(acts, onPlace ? ["mention", "place", "remove"] : ["mention", "rename", "remove"])} more={onPlace ? acts : undefined} label={a.name} />
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
      {menu.menu}
    </div>
  );
}

function NewNoteDialog({ roomId, local, ctx, onClose, onAdded }: { roomId: string; local: boolean; ctx: InlineContext; onClose: () => void; onAdded: (a: ArtifactAdded) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!name.trim() && text.length <= MAX_NOTE_TEXT && !busy;
  const add = async (confirmSecret = false): Promise<void> => {
    if (!ok) return;
    setBusy(true);
    const r = await settled<ArtifactAdded | SecretConfirm | { error: string }>(window.mb.artifactsAddNote(roomId, name.trim(), text, confirmSecret));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    if ("needsConfirm" in r) return window.confirm(`${r.reason}. Add “${name.trim()}” anyway?`) ? add(true) : undefined;
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
      <div className="sub-h">{local ? "Markdown kept in this area on this Mac — specs, decisions, checklists. The area's agents read it too." : "Markdown everyone in the room can read and edit — specs, decisions, checklists. Room agents read it too."}</div>
      <label>Name</label>
      <input type="text" autoFocus value={name} maxLength={MAX_ARTIFACT_NAME} placeholder="e.g. Last-org spec" onChange={(e) => setName(e.target.value)} />
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
        <button className="primary" disabled={!ok} onClick={() => add()}>
          Add note <span className="kbd">⌘↵</span>
        </button>
      </div>
    </Modal>
  );
}

function LinkDialog({ roomId, local, onClose, onAdded }: { roomId: string; local: boolean; onClose: () => void; onAdded: () => void }) {
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
    const r = await settled(window.mb.artifactsAddLink(roomId, url.trim(), title.trim()));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    onAdded();
  };
  return (
    <Modal className="modal close-dlg art-link-dlg" onClose={onClose}>
      <h3>Add a link</h3>
      <div className="sub-h">A page {local ? "this area" : "the room"} should have at hand — a ticket, a PR, a design. https only.</div>
      <label>Link</label>
      <input
        type="text"
        autoFocus
        value={url}
        placeholder="e.g. https://dev.azure.com/…/edit/5110"
        onChange={(e) => {
          const next = e.target.value;
          setUrl(next);
          const l = linkLabel(next.trim());
          if (!titled) setTitle(l ? l.label ?? l.host : "");
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
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
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
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
  local,
  session,
  path,
  line,
  onClose,
  onAdded,
}: {
  roomId: string;
  local: boolean;
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
    const r = await settled<ArtifactAdded | { error: string }>(window.mb.artifactsAddRepo(roomId, { sessionId: session.id, path, lines: parsed.lines, name: name.trim() }));
    setBusy(false);
    if (isErr(r)) return setError(failed("Not added", r.error));
    onAdded(r);
  };
  return (
    <Modal className="modal close-dlg art-repo-dlg" onClose={onClose}>
      <h3>Reference a repo file</h3>
      <div className="sub-h">
        <span className="tk-path">{path}</span> in {baseName(session.cwd)}, at its current commit. {local ? "It opens in your clone" : "Teammates open it in their own clone of the repo"} — nothing is copied.
      </div>
      <label>Lines (optional)</label>
      <input
        type="text"
        autoFocus
        value={lines}
        placeholder="e.g. 12 or 12–40"
        onChange={(e) => {
          setLines(e.target.value);
          const p = parseLines(e.target.value);
          if (!named && !("error" in p)) setName(repoDefaultName(path, p.lines));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
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
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
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
