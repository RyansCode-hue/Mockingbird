import { useEffect, useRef, useState, type ReactNode } from "react";
import { CHANGELOG, CHANGE_KIND_LABEL, COMING_NEXT, releaseOf, shortDate, type Change } from "../shared/changelog";
import {
  SUGGESTION_LABEL,
  SUGGESTION_LABELS,
  SUGGESTION_STATUS_LABEL,
  TITLE_MAX,
  BODY_MAX,
  composeSuggestion,
  draftProblem,
  isSuggestProblem,
  suggestionText,
  type SuggestPosted,
  type SuggestProblem,
  type SuggestTarget,
  type Suggestion,
  type SuggestionDraft,
  type SuggestionList,
} from "../shared/suggestions";
import { isErr } from "../shared/types";
import { ChevronIcon } from "./Icons";
import { Popover } from "./Popover";
import { useCopyNote, CopyToast } from "./copyNote";
import { versionLabel } from "./whatsNewModel";

type View =
  | { at: "notes" }
  | { at: "form"; error?: string }
  | { at: "checking"; draft: SuggestionDraft }
  | { at: "confirm"; draft: SuggestionDraft; target: SuggestTarget }
  | { at: "posting"; draft: SuggestionDraft; target: SuggestTarget }
  | { at: "posted"; posted: SuggestPosted }
  | { at: "problem"; draft: SuggestionDraft; problem: SuggestProblem };

type ListState = { at: "idle" } | { at: "loading" } | { at: "ok"; list: SuggestionList } | { at: "problem"; problem: SuggestProblem } | { at: "error"; error: string };

/** An IPC answer that's an expected problem, a failure ({ error }), or the value. */
function asProblem(r: unknown): SuggestProblem | null {
  if (isSuggestProblem(r)) return r;
  if (isErr(r)) return { problem: "failed", message: r.error };
  return null;
}

/** Focuses the element it's given once, when it mounts: each step's heading, so the keyboard stays in the popover. */
const focusOnMount = (el: HTMLElement | null) => el?.focus({ preventScroll: true });

function Fold({ id, title, open, onToggle, sub, children }: { id: string; title: ReactNode; open: boolean; onToggle: (id: string) => void; sub?: boolean; children: ReactNode }) {
  return (
    <div className={`wn-fold${sub ? " sub" : ""}`} data-fold={id}>
      <button className="wn-fold-btn" aria-expanded={open} onClick={() => onToggle(id)}>
        <ChevronIcon open={open} />
        {title}
      </button>
      {open && <div className="wn-fold-body">{children}</div>}
    </div>
  );
}

function Items({ items }: { items: Change[] }) {
  return (
    <ul className="wn-items">
      {items.map((c, i) => (
        <li key={i}>
          <span className={`wn-tag ${c.kind}`}>{CHANGE_KIND_LABEL[c.kind]}</span>
          <span className="wn-text">{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

function SuggestionRows({ items, open }: { items: Suggestion[]; open: (url: string) => void }) {
  return (
    <ul className="wn-sugs">
      {items.map((s) => (
        <li key={s.number}>
          <button className="wn-sug-link" title={`Open #${s.number} on GitHub`} onClick={() => open(s.url)}>
            <span className="wn-sug-n">#{s.number}</span>
            <span className="wn-sug-title">{s.title}</span>
          </button>
          <span className={`wn-status ${s.status}`}>{SUGGESTION_STATUS_LABEL[s.status]}</span>
        </li>
      ))}
    </ul>
  );
}

function ProblemText({ problem, onCopyFix }: { problem: SuggestProblem; onCopyFix: (cmd: string) => void }) {
  return (
    <div className="wn-problem" role="alert">
      <div className="err">{problem.message}</div>
      {problem.fix && (
        <div className="wn-fix">
          <span>To fix it, run this in a terminal, then try again:</span>
          <span className="wn-cmd">
            <code>{problem.fix}</code>
            <button className="link" onClick={() => onCopyFix(problem.fix!)}>
              Copy
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The top bar's version label and its What's new popover: this version's
 * changes, earlier versions and what's coming next as fold-outs, and Suggest
 * something, which files a GitHub issue through the user's own gh once they've
 * seen exactly what will be posted.
 */
export function WhatsNew({ version, updated, open, onOpen, onClose }: { version: string; updated: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<View>({ at: "notes" });
  const [folds, setFolds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [list, setList] = useState<ListState>({ at: "idle" });
  const [note, copy] = useCopyNote();
  const release = releaseOf(version);
  const earlier = CHANGELOG.filter((r) => r !== release);

  const close = () => {
    onClose();
    // a finished filing goes back to the notes; a draft in progress stays for next time
    setView((v) => (v.at === "posted" || v.at === "problem" || v.at === "checking" ? { at: "notes" } : v.at === "confirm" ? { at: "form" } : v));
    btn.current?.focus({ preventScroll: true });
  };
  const loadList = (fresh = false) => {
    setList({ at: "loading" });
    window.mb.suggestList(fresh).then(
      (r: unknown) => {
        const p = asProblem(r);
        if (p?.problem === "failed" && isErr(r)) setList({ at: "error", error: p.message });
        else if (p) setList({ at: "problem", problem: p });
        else setList({ at: "ok", list: r as SuggestionList });
      },
      (err: unknown) => setList({ at: "error", error: String(err) })
    );
  };
  const toggle = (id: string) => {
    const opening = !folds.has(id);
    setFolds((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    // the list is read when its fold opens, and kept (main caches it briefly) until Refresh
    if (opening && id === "suggestions" && list.at !== "ok" && list.at !== "loading") loadList();
  };
  const openUrl = (url: string) =>
    window.mb.openExternal(url).then((r: unknown) => {
      if (isErr(r)) console.error(`[mockingbird] couldn't open ${url}: ${r.error}`);
    });

  const review = () => {
    const draft = composeSuggestion(title, desc, version);
    const bad = draftProblem(draft);
    if (bad) return setView({ at: "form", error: bad });
    setView({ at: "checking", draft });
    window.mb.suggestPrepare().then(
      (r: unknown) => {
        const p = asProblem(r);
        setView(p ? { at: "problem", draft, problem: p } : { at: "confirm", draft, target: r as SuggestTarget });
      },
      (err: unknown) => setView({ at: "problem", draft, problem: { problem: "failed", message: String(err) } })
    );
  };
  const post = (draft: SuggestionDraft, target: SuggestTarget) => {
    setView({ at: "posting", draft, target });
    window.mb.suggestPost(draft).then(
      (r: unknown) => {
        const p = asProblem(r);
        if (p) return setView({ at: "problem", draft, problem: p });
        setTitle("");
        setDesc("");
        setView({ at: "posted", posted: r as SuggestPosted });
        if (folds.has("suggestions")) loadList(true);
        else setList({ at: "idle" });
      },
      (err: unknown) => setView({ at: "problem", draft, problem: { problem: "failed", message: String(err) } })
    );
  };

  // the dialog opens on the notes whenever it's opened by itself after an update
  useEffect(() => {
    if (open && updated) setView({ at: "notes" });
  }, [open, updated]);

  const label = versionLabel(version, updated);
  const notes = (
    <>
      <div className="wn-head">
        <h3 tabIndex={-1} ref={focusOnMount}>
          {release ? (
            <>
              What's new in {release.version} <span className="wn-date">· {shortDate(release.date)}</span>
            </>
          ) : (
            <>What's new in {version}</>
          )}
        </h3>
      </div>
      <div className="wn-body">
        {release ? <Items items={release.items} /> : <div className="wn-empty">No notes for {version} yet.</div>}
        <Fold id="earlier" title="Earlier versions" open={folds.has("earlier")} onToggle={toggle}>
          {earlier.map((r) => (
            <Fold
              key={r.version}
              id={`v${r.version}`}
              sub
              title={
                <>
                  {r.version} <span className="wn-date">· {shortDate(r.date)}</span>
                </>
              }
              open={folds.has(`v${r.version}`)}
              onToggle={toggle}
            >
              <Items items={r.items} />
            </Fold>
          ))}
        </Fold>
        <Fold id="next" title="Coming next" open={folds.has("next")} onToggle={toggle}>
          <ul className="wn-next">
            {COMING_NEXT.map((c) => (
              <li key={c.title}>
                <span className="wn-next-title">{c.title}</span>
                <span className="wn-text">{c.text}</span>
              </li>
            ))}
          </ul>
        </Fold>
        <Fold id="suggestions" title="Suggestions" open={folds.has("suggestions")} onToggle={toggle}>
          {list.at === "loading" && <div className="wn-empty">Reading suggestions from GitHub…</div>}
          {list.at === "error" && (
            <div className="wn-problem" role="alert">
              <div className="err">Couldn't read the suggestions: {list.error}</div>
              <button className="link" onClick={() => loadList(true)}>
                Try again
              </button>
            </div>
          )}
          {list.at === "problem" && (
            <>
              <ProblemText problem={list.problem} onCopyFix={(c) => copy(c, "the command")} />
              <button className="link" onClick={() => loadList(true)}>
                Try again
              </button>
            </>
          )}
          {list.at === "ok" && (
            <>
              {list.list.items.length === 0 ? (
                <div className="wn-empty">No suggestions on {list.list.repo} yet.</div>
              ) : (
                <>
                  {list.list.items.some((s) => s.mine) && (
                    <>
                      <div className="wn-sub-h">Yours</div>
                      <SuggestionRows items={list.list.items.filter((s) => s.mine)} open={openUrl} />
                    </>
                  )}
                  {list.list.items.some((s) => !s.mine) && (
                    <>
                      <div className="wn-sub-h">Everyone's</div>
                      <SuggestionRows items={list.list.items.filter((s) => !s.mine)} open={openUrl} />
                    </>
                  )}
                </>
              )}
              <button className="link wn-refresh" onClick={() => loadList(true)}>
                Refresh
              </button>
            </>
          )}
        </Fold>
      </div>
      <div className="wn-foot">
        <button className="outline" onClick={() => setView({ at: "form" })}>
          Suggest something
        </button>
      </div>
    </>
  );

  const form = view.at === "form" && (
    <>
      <div className="wn-head">
        <h3>Suggest something</h3>
      </div>
      <div className="wn-body wn-form">
        <label>
          <span>Title</span>
          <input autoFocus value={title} maxLength={TITLE_MAX} placeholder="What should Mockingbird do?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && review()} />
        </label>
        <label>
          <span>
            Description <span className="wn-opt">optional</span>
          </span>
          <textarea rows={5} value={desc} maxLength={BODY_MAX - 200} placeholder="Why it would help, or how you'd expect it to work" onChange={(e) => setDesc(e.target.value)} />
        </label>
        {view.error && <div className="err">{view.error}</div>}
        <div className="wn-hint">Nothing is sent yet: the next step shows exactly what will be posted, and where.</div>
      </div>
      <div className="wn-foot">
        <button className="outline" onClick={() => setView({ at: "notes" })}>
          Back
        </button>
        <button className="primary" disabled={!title.trim()} title={title.trim() ? undefined : "Give it a title first"} onClick={review}>
          Review…
        </button>
      </div>
    </>
  );

  const confirm = (view.at === "confirm" || view.at === "posting" || view.at === "checking") && (
    <>
      <div className="wn-head">
        <h3 tabIndex={-1} ref={focusOnMount}>
          Post this suggestion?
        </h3>
      </div>
      <div className="wn-body">
        {view.at === "checking" ? (
          <div className="wn-empty">Checking GitHub…</div>
        ) : (
          <>
            <div className="wn-where">
              Files a GitHub issue on <b>{view.target.repo}</b> as <b>@{view.target.login}</b>. Everyone with access to the repository can see it.
            </div>
            <div className="wn-preview">
              <div className="wn-preview-title">{view.draft.title}</div>
              <pre>{view.draft.body}</pre>
            </div>
            <div className="wn-labels">
              {view.target.labels === "existing" && (
                <>
                  Labelled <code>{SUGGESTION_LABEL}</code>.
                </>
              )}
              {view.target.labels === "create" && (
                <>
                  Labelled <code>{SUGGESTION_LABEL}</code>. The repository has no suggestion labels yet, so this also creates{" "}
                  {SUGGESTION_LABELS.map((l, i) => (
                    <span key={l.name}>
                      {i > 0 ? (i === SUGGESTION_LABELS.length - 1 ? " and " : ", ") : ""}
                      <code>{l.name}</code>
                    </span>
                  ))}{" "}
                  on it.
                </>
              )}
              {view.target.labels === "none" && view.target.labelNote}
            </div>
          </>
        )}
      </div>
      <div className="wn-foot">
        <button className="outline" disabled={view.at === "posting"} onClick={() => setView({ at: "form" })}>
          Back
        </button>
        <button className="primary" disabled={view.at !== "confirm"} onClick={() => view.at === "confirm" && post(view.draft, view.target)}>
          {view.at === "posting" ? "Posting…" : "Post suggestion"}
        </button>
      </div>
    </>
  );

  const posted = view.at === "posted" && (
    <>
      <div className="wn-head">
        <h3 tabIndex={-1} ref={focusOnMount}>
          Suggestion filed
        </h3>
      </div>
      <div className="wn-body">
        <div className="wn-where">
          Filed as{" "}
          <button className="link" onClick={() => openUrl(view.posted.url)}>
            #{view.posted.number}
          </button>
          {view.posted.labelled ? (
            <>
              , labelled <code>{SUGGESTION_LABEL}</code>.
            </>
          ) : (
            "."
          )}
        </div>
        {view.posted.note && <div className="wn-hint">{view.posted.note}</div>}
      </div>
      <div className="wn-foot">
        <button className="outline" onClick={() => openUrl(view.posted.url)}>
          Open on GitHub
        </button>
        <button className="primary" onClick={() => setView({ at: "notes" })}>
          Done
        </button>
      </div>
    </>
  );

  const problem = view.at === "problem" && (
    <>
      <div className="wn-head">
        <h3 tabIndex={-1} ref={focusOnMount}>
          {view.problem.problem === "no-access" ? "No access to the repository" : "Couldn't file the suggestion"}
        </h3>
      </div>
      <div className="wn-body">
        <ProblemText problem={view.problem} onCopyFix={(c) => copy(c, "the command")} />
        <div className="wn-hint">Nothing was posted. You can copy the suggestion and send it another way.</div>
      </div>
      <div className="wn-foot">
        <button className="outline" onClick={() => setView({ at: "form" })}>
          Back
        </button>
        <button className="outline" onClick={() => copy(suggestionText(view.draft), "the suggestion")}>
          Copy suggestion
        </button>
        {view.problem.problem !== "dev-build" && (
          <button className="primary" onClick={review}>
            Try again
          </button>
        )}
      </div>
    </>
  );

  return (
    <span className="ver-wrap">
      <button
        ref={btn}
        className={`ver${updated ? " updated" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={updated ? `Mockingbird was updated to ${version}: see what's new` : "What's new"}
        onClick={() => (open ? close() : onOpen())}
      >
        {label}
      </button>
      {open && (
        <Popover className="wn-pop" label="What's new" onClose={close}>
          {view.at === "notes" && notes}
          {form}
          {confirm}
          {posted}
          {problem}
          <CopyToast note={note} failed="Couldn't copy" />
        </Popover>
      )}
    </span>
  );
}
