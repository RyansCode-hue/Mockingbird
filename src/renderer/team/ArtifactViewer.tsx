import { useEffect, useMemo, useRef, useState } from "react";
import { isErr } from "../../shared/types";
import { fileSize } from "../../shared/format";
import { externalUrlAllowed } from "../../shared/links";
import { tildePath } from "../../shared/paths";
import type { ArtifactContent, ArtifactSummary, RepoResolution, SaveNoteMode, SaveNoteResult } from "../../shared/team/artifacts";
import { Modal } from "../Modal";
import { MenuButton } from "../Menu";
import { FileGlyph } from "../FilePanel";
import { LinkIcon, LockIcon, NoteIcon, RepoFileIcon } from "../Icons";
import { settled } from "../settled";
import { openLink } from "../uiUtil";
import { INLINE_IMAGE_MIME, addedLine, artifactMeta, parseCsv, repoTarget, transferLine } from "./artifactModel";
import { MarkdownView, type InlineContext } from "./markdownView";

/**
 * A room artifact opened from the Team tab (docs/team-rooms.md →
 * Artifacts): images, markdown, notes (editable), text and CSV shown here;
 * PDFs and other files open in macOS Quick Look, never rendered in the app.
 * A repo file opens in the editor from this Mac's clone, or — when it's
 * changed since, or there's no clone — is shown here as it was.
 *
 * Teammates' content is shown as React elements only; an image only from
 * the bytes main sniffed as one, through a blob: URL revoked on close.
 * Quick Look, Reveal and Save as act on files main picks, on a click.
 */

/** An artifact's kind at a glance: a file's type badge, or the kind's icon. */
export function ArtifactGlyph({ a }: { a: Pick<ArtifactSummary, "kind" | "name"> }) {
  if (a.kind === "file") return <FileGlyph path={a.name} />;
  const Icon = a.kind === "note" ? NoteIcon : a.kind === "repo" ? RepoFileIcon : LinkIcon;
  return (
    <span className={`fp-glyph plain art-k-${a.kind}`}>
      <Icon />
    </span>
  );
}

/** Write / Preview for a note being written. */
export function WritePreview({ preview, setPreview }: { preview: boolean; setPreview: (p: boolean) => void }) {
  return (
    <div className="seg art-seg">
      <button className={preview ? "" : "on"} onClick={() => setPreview(false)}>
        Write
      </button>
      <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
        Preview
      </button>
    </div>
  );
}

/** A note's text being written, or its preview. */
export function NoteBody({ text, setText, preview, ctx, autoFocus = true }: { text: string; setText: (t: string) => void; preview: boolean; ctx?: InlineContext; autoFocus?: boolean }) {
  return preview ? (
    <div className="art-scroll">{text.trim() ? <MarkdownView className="art-md" text={text} ctx={ctx} /> : <div className="art-quiet">Nothing written yet.</div>}</div>
  ) : (
    <textarea
      className="art-note-text"
      autoFocus={autoFocus}
      spellCheck
      value={text}
      placeholder="Markdown: # headings, **bold**, - lists, ``` code, | tables |, [links](https://…)"
      onChange={(e) => setText(e.target.value)}
    />
  );
}

/** Lines of text with their numbers; `mark` highlights a range and scrolls it into view. */
function NumberedText({ text, mark }: { text: string; mark?: [number, number] | null }) {
  const MAX_LINES = 20_000;
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => first.current?.scrollIntoView({ block: "center" }), [text, mark?.[0]]);
  const marked = (n: number) => !!mark && n >= mark[0] && n <= mark[1];
  return (
    <div className="art-code">
      {lines.slice(0, MAX_LINES).map((l, i) => (
        <div key={i} ref={mark && i + 1 === mark[0] ? first : undefined} className={`art-ln ${marked(i + 1) ? "mark" : ""}`}>
          <span className="art-gut">{i + 1}</span>
          <span className="art-lt">{l || " "}</span>
        </div>
      ))}
      {lines.length > MAX_LINES && <div className="art-quiet">… {(lines.length - MAX_LINES).toLocaleString()} more lines — Save as… to read them all.</div>}
    </div>
  );
}

function CsvView({ text }: { text: string }) {
  const t = useMemo(() => parseCsv(text), [text]);
  if (!t.rows.length) return <div className="art-quiet">This CSV is empty.</div>;
  const [head, ...rows] = t.rows;
  const cols = Math.max(...t.rows.map((r) => r.length));
  return (
    <>
      <div className="art-csv">
        <table>
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, i) => (
                <th key={i}>{head[i] ?? ""}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {Array.from({ length: cols }, (_, ci) => (
                  <td key={ci}>{r[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(t.moreRows || t.moreCols) && (
        <div className="art-quiet">
          Showing the first {t.rows.length.toLocaleString()} rows{t.moreCols ? ` and ${cols} columns` : ""} — Save as… or Quick Look for the rest.
        </div>
      )}
    </>
  );
}

function ImageView({ bytes, mime, name }: { bytes: Uint8Array; mime: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  if (broken) return <div className="err">This image couldn't be shown here — Quick Look may open it.</div>;
  return (
    <div className="art-img">
      {url && (
        <img
          src={url}
          alt={name}
          draggable={false}
          onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
          onError={() => setBroken(true)}
        />
      )}
      {size && <div className="art-quiet">{size}</div>}
    </div>
  );
}

/** A file this Mac doesn't have yet: how it's coming, and a way to hurry it or try again. */
function Transfer({ item, onDownload }: { item: ArtifactSummary; onDownload: () => void }) {
  const x = transferLine(item);
  if (!x) return <div className="art-quiet">Reading the file…</div>;
  return (
    <div className="art-card">
      <div className="art-card-title">{x.pct === undefined ? "Not on this Mac yet" : "Downloading"}</div>
      <div className="art-xfer-big">{x.text}</div>
      {x.pct !== undefined && (
        <div className="art-bar">
          <span style={{ width: `${x.pct}%` }} />
        </div>
      )}
      {x.action && (
        <button className="outline" onClick={onDownload}>
          {x.action}
        </button>
      )}
    </div>
  );
}

type Loaded = ArtifactContent | { error: string } | null;
type Resolved = RepoResolution | { error: string } | null;

export function ArtifactViewer({
  roomId,
  self,
  item,
  ctx,
  focusedSessionId,
  onClose,
  onOpen,
  onOpenRepoFile,
  onRename,
  onRemove,
  onMention,
  local = false,
}: {
  /** The shelf: a room's id, or an area's (`area:<key>`, shared/areaArtifacts.ts). */
  roomId: string;
  /** An area's artifacts on this Mac rather than a room's: its words say so. */
  local?: boolean;
  self: string;
  /** The artifact as the room's view has it now; undefined once it's removed. */
  item: ArtifactSummary | undefined;
  /** Chips for the references inside a note. */
  ctx: InlineContext;
  focusedSessionId: string | null;
  onClose: () => void;
  /** Show another artifact here (a copy just saved, the note a conflict copy came from). */
  onOpen: (id: string) => void;
  onOpenRepoFile: (open: NonNullable<RepoResolution["open"]>) => void;
  onRename: (a: ArtifactSummary) => void;
  onRemove: (a: ArtifactSummary) => void;
  onMention: (a: ArtifactSummary) => void;
}) {
  const [content, setContent] = useState<Loaded>(null);
  const [repo, setRepo] = useState<Resolved>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [editing, setEditing] = useState<{ base: string; text: string; from: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [stale, setStale] = useState<{ byName: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const looked = useRef(false);

  const id = item?.id;
  const present = item?.kind === "file" && item.local?.state === "present";
  // what the content depends on: a file arriving, a note's revision
  const contentKey = item?.kind === "file" ? String(present) : item?.kind === "note" ? item.rev ?? "" : "";

  const read = () => settled<ArtifactContent | { error: string }>(window.mb.artifactsRead(roomId, id!));
  useEffect(() => {
    if (!item || item.kind === "repo" || item.kind === "link") return;
    if (item.kind === "file" && !present) return setContent(null);
    let live = true;
    read().then((r) => live && setContent(r));
    return () => {
      live = false;
    };
  }, [id, contentKey]);

  const act = async (what: string, call: () => Promise<unknown>, done?: (r: any) => string | null) => {
    setStatus(null);
    const r = await settled(call());
    if (isErr(r)) return setStatus({ text: `Couldn't ${what}: ${r.error}`, error: true });
    const text = done?.(r);
    if (text) setStatus({ text });
  };
  const download = () => act("download it", () => window.mb.artifactsDownload(roomId, id!));
  const quickLook = () => act("open Quick Look", () => window.mb.artifactsQuickLook(roomId, id!));
  const reveal = () => act("show it in Finder", () => window.mb.artifactsReveal(roomId, id!));
  const saveAs = () => act("save a copy", () => window.mb.artifactsSaveAs(roomId, id!), (r: { path: string } | null) => (r ? `Saved to ${tildePath(r.path)}` : null));

  // a person opening a file fetches it ahead of the queue
  useEffect(() => {
    const s = item?.kind === "file" ? item.local?.state : undefined;
    if (s === "on-demand" || s === "queued") download();
  }, [id]);
  // a PDF opens in Quick Look, once, when it's there to open
  useEffect(() => {
    if (content && !isErr(content) && content.view === "pdf" && !looked.current) {
      looked.current = true;
      quickLook();
    }
  }, [content]);
  // a repo file opens in the editor when there's a clone with it unchanged; otherwise it's shown here as it was
  useEffect(() => {
    if (item?.kind !== "repo") return;
    let live = true;
    settled<RepoResolution | { error: string }>(window.mb.artifactsResolveRepo(roomId, item.id, focusedSessionId)).then((r) => {
      if (!live) return;
      if (!isErr(r) && r.open && r.changedSince !== true) {
        onOpenRepoFile(r.open);
        onClose();
        return;
      }
      setRepo(r);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const startEdit = async () => {
    const r = await read();
    if (isErr(r) || r.view !== "note") return setStatus({ text: `Couldn't open the note to edit: ${isErr(r) ? r.error : "it isn't a note"}`, error: true });
    setContent(r);
    setEditing({ base: r.rev, text: r.text, from: r.text });
    setPreview(false);
    setStale(null);
  };
  const save = async (mode: SaveNoteMode, confirmSecret = false): Promise<void> => {
    if (!editing || !item || saving) return;
    setSaving(true);
    // overwriting replaces the revision on screen now; saving checks against the one the edit started from
    const base = mode === "overwrite" ? item.rev ?? editing.base : editing.base;
    const r = await settled<SaveNoteResult | { error: string }>(window.mb.artifactsSaveNote(roomId, item.id, editing.text, base, mode, confirmSecret));
    setSaving(false);
    if (isErr(r)) return setStatus({ text: `Not saved: ${r.error}`, error: true });
    if ("needsConfirm" in r) return window.confirm(`${r.reason}. Save it anyway?`) ? save(mode, true) : undefined;
    if ("stale" in r) return setStale({ byName: r.stale.byName });
    setEditing(null);
    setStale(null);
    if ("copy" in r) {
      setStatus({ text: "Saved as a copy" });
      onOpen(r.copy);
    } else setStatus({ text: "Saved" });
  };
  const reload = async () => {
    const r = await read();
    if (isErr(r) || r.view !== "note") return setStatus({ text: `Couldn't reload the note: ${isErr(r) ? r.error : "it isn't a note"}`, error: true });
    setContent(r);
    setEditing({ base: r.rev, text: r.text, from: r.text });
    setStale(null);
  };
  const dirty = !!editing && editing.text !== editing.from;
  const close = () => {
    if (dirty && !window.confirm(`Discard your edit of “${item?.name}”?`)) return;
    onClose();
  };

  if (!item) {
    return (
      <Modal className="modal art-dlg" onClose={onClose}>
        <h3>Removed</h3>
        <div className="sub-h">This artifact was removed from the {local ? "area" : "room"}.</div>
        <div className="row">
          <button className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  const crossed = !!editing && ((item.rev && item.rev !== editing.base) || !!stale);
  const crossedBy = stale?.byName ?? item.updatedByName ?? "A teammate";
  const loaded = content && !isErr(content) ? content : null;
  const fileActions = present && (
    <>
      <button className="outline" onClick={quickLook} title="Open it in macOS Quick Look">
        Quick Look
      </button>
      <button className="outline" onClick={reveal} title="Show this Mac's copy in Finder">
        Reveal in Finder
      </button>
      <button className="outline" onClick={saveAs} title="Save a copy somewhere else">
        Save as…
      </button>
    </>
  );
  const more = (
    <MenuButton
      className="outline art-more"
      label="⋯"
      title="More for this artifact"
      items={[
        { key: "mention", label: local ? "Mention to the selected workspace" : "Mention in a message", onPick: () => (onMention(item), onClose()) },
        { key: "rename", label: "Rename…", onPick: () => onRename(item) },
        { key: "remove", label: local ? "Remove…" : "Remove for everyone…", onPick: () => onRemove(item) },
      ]}
    />
  );

  const body = (() => {
    if (item.kind === "repo") {
      if (!repo) return <div className="art-quiet">Finding {item.path} in your clones…</div>;
      if (isErr(repo)) return <div className="err">Couldn't find the file: {repo.error}</div>;
      return (
        <>
          {repo.problem ? (
            <div className="art-banner warn">{repo.problem}</div>
          ) : repo.changedSince ? (
            <div className="art-banner">
              {item.path} has changed since {repo.commit.slice(0, 7)} — below is the file as it was.
            </div>
          ) : null}
          {repo.atCommit ? (
            <>
              <NumberedText text={repo.atCommit.text} mark={repo.lines} />
              {repo.atCommit.truncated && <div className="art-quiet">The file is longer than shown here.</div>}
            </>
          ) : (
            <div className="art-quiet">The file at {repo.commit.slice(0, 7)} isn't readable on this Mac.</div>
          )}
        </>
      );
    }
    if (item.kind === "link") {
      const url = item.url ?? "";
      const ok = externalUrlAllowed(url);
      return (
        <div className="art-card">
          <div className="art-card-title">{item.label ?? item.host}</div>
          <div className="art-url">{url}</div>
          <div className="row-left">
            <button className="primary" disabled={!ok} onClick={() => openLink(url)}>
              Open in browser
            </button>
            <span className="art-quiet">{ok ? `Opens ${item.host} in your browser` : "Only https links open"}</span>
          </div>
        </div>
      );
    }
    if (item.kind === "note" && editing) {
      return (
        <>
          {crossed && (
            <div className="art-banner warn art-stale">
              <span>{crossedBy} edited this while you were editing.</span>
              <span className="art-banner-acts">
                <button className="outline" disabled={saving} onClick={() => save("overwrite")} title="Replace their edit with yours">
                  Overwrite
                </button>
                <button className="outline" disabled={saving} onClick={() => save("copy")} title="Keep theirs, and add yours as a new note">
                  Save mine as a copy
                </button>
                <button className="outline" disabled={saving} onClick={reload} title="Drop your edit and show theirs">
                  Reload
                </button>
              </span>
            </div>
          )}
          <NoteBody text={editing.text} setText={(text) => setEditing({ ...editing, text })} preview={preview} ctx={ctx} />
        </>
      );
    }
    if (item.kind === "file" && !present) return <Transfer item={item} onDownload={download} />;
    if (!content) return <div className="art-quiet">Reading…</div>;
    if (isErr(content)) return <div className="err">Couldn't read it: {content.error}</div>;
    switch (content.view) {
      case "image":
        return INLINE_IMAGE_MIME.test(content.mime) ? (
          <ImageView bytes={content.bytes} mime={content.mime} name={item.name} />
        ) : (
          <div className="art-quiet">This image type isn't shown here — Quick Look opens it.</div>
        );
      case "note":
        return <div className="art-scroll">{content.text.trim() ? <MarkdownView className="art-md" text={content.text} ctx={ctx} /> : <div className="art-quiet">This note is empty.</div>}</div>;
      case "markdown":
        return (
          <div className="art-scroll">
            <MarkdownView className="art-md" text={content.text} ctx={ctx} />
            {content.truncated && <div className="art-quiet">The file is longer than shown here — Save as… to read it all.</div>}
          </div>
        );
      case "text":
        return (
          <>
            <NumberedText text={content.text} />
            {content.truncated && <div className="art-quiet">The file is longer than shown here — Save as… to read it all.</div>}
          </>
        );
      case "csv":
        return <CsvView text={content.text} />;
      case "pdf":
      case "binary":
        return (
          <div className="art-card">
            <div className="art-card-title">
              <ArtifactGlyph a={item} /> {item.name}
            </div>
            <div className="art-quiet">
              {fileSize(content.size)} · {content.mime}
            </div>
            <div className="art-quiet">{content.view === "pdf" ? "PDFs open in Quick Look, not in Mockingbird." : "Files like this open in Quick Look, not in Mockingbird."}</div>
            <div className="row-left">
              <button className="primary" onClick={quickLook}>
                Quick Look
              </button>
            </div>
          </div>
        );
      case "missing":
        return <Transfer item={item} onDownload={download} />;
      case "link":
        return null;
    }
  })();

  const original = item.conflictOf ? item.conflictOf : null;
  return (
    <Modal
      className="modal art-dlg"
      onClose={close}
      closeOnBackdrop={!editing}
      onKeyDown={(e) => {
        if (editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          save("save");
        }
      }}
    >
      <div className="art-head">
        <ArtifactGlyph a={item} />
        <div className="art-title">
          <h3 title={item.name}>{item.name}</h3>
          <div className="art-sub">
            {item.kind === "repo" ? `${item.origin} · ${repoTarget(item)}` : artifactMeta(item, self)}
          </div>
        </div>
        <div className="art-head-acts">
          {editing ? (
            <>
              <WritePreview preview={preview} setPreview={setPreview} />
              <button className="outline" onClick={() => (dirty && !window.confirm("Discard your edit?") ? null : (setEditing(null), setStale(null)))}>
                Cancel
              </button>
              <button className="primary" disabled={saving || !dirty || crossed} onClick={() => save("save")} title={crossed ? "Choose what to do with your edit above" : undefined}>
                Save <span className="kbd">⌘S</span>
              </button>
            </>
          ) : (
            <>
              {fileActions}
              {item.kind === "note" && (
                <button className="outline" onClick={startEdit}>
                  Edit
                </button>
              )}
              {item.kind === "repo" && repo && !isErr(repo) && repo.open && (
                <button className="outline" onClick={() => (onOpenRepoFile(repo.open!), onClose())} title="Open the file as it is now in the editor">
                  Open the current file
                </button>
              )}
              {more}
            </>
          )}
        </div>
      </div>
      {item.agentsBlocked && (
        <div className="art-banner art-lock-note">
          <LockIcon /> {local ? "Agents" : "Agents in the room"} can't read this: {item.agentsBlocked}
        </div>
      )}
      {original && (
        <div className="art-banner">
          An edit that crossed another — kept as its own note.{" "}
          <button className="link" onClick={() => onOpen(original)}>
            Open the note it was an edit of
          </button>
        </div>
      )}
      <div className={`art-body art-v-${editing ? "edit" : loaded?.view ?? item.kind}`}>{body}</div>
      <div className="art-foot">
        {status ? <span className={status.error ? "err" : "art-ok"}>{status.text}</span> : <span className="art-quiet">{addedLine(item, self)}</span>}
        <button className="outline" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}
