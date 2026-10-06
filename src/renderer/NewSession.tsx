import { useEffect, useMemo, useState } from "react";
import { Snippet } from "./TranscriptSearch";
import { Pick, Select } from "./Menu";
import { suggestTicketName, ticketKickoffPrompt, ticketsByColumn, useAdoTickets, useRepoBranches } from "./tickets";
import { newPresetId } from "./Presets";
import { isErr, AGENT_NAME, slugBranch, sanitizeSegment, splitGroupKey, topOfKey, groupKey, ticketIdOf, type AgentKind, type SessionInfo, type SessionPreset, type RepoEntry, type ImportableConversation, type TranscriptHit, type ModelCatalog } from "../shared/types";
import { agoShort } from "../shared/format";
import { tildePath } from "../shared/paths";
import { Modal } from "./Modal";
import { usePersisted, writePref, readPref } from "./prefs";
import { COLUMN_PREFS_KEY, legacyColumnPrefs, type ColumnPrefs } from "./boardView";
import { useAction } from "./useAction";

/** Starting sessions: New session (⌘N) and Import. */

export type LaunchKind = AgentKind | "shell";

export function NewSessionModal({
  existingGroups,
  initialLaunch,
  initialGroup,
  presets,
  onStartPreset,
  onSavePreset,
  onClose,
  onCreated,
}: {
  existingGroups: string[];
  initialLaunch?: LaunchKind;
  initialGroup?: string; // "5038" or "5038/backend" — a workspace path adds a tab there
  presets: SessionPreset[];
  onStartPreset: (p: SessionPreset) => void;
  /** Save what's filled in as a preset (opens the preset editor). */
  onSavePreset: (draft: SessionPreset) => void;
  onClose: () => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const [launch, setLaunch] = useState<LaunchKind>(initialLaunch ?? "claude");
  const isAgent = launch !== "shell";
  const agentLabel = AGENT_NAME[launch === "codex" ? "codex" : "claude"];
  // model/effort ride the agent's command line; the last choice is remembered
  // per agent because people tend to have a working default for each
  const [model, setModel] = usePersisted("mb.newModel", "");
  const [modelCustom, setModelCustom] = usePersisted("mb.newModelCustom", "");
  const [effort, setEffort] = usePersisted("mb.newEffort", "");
  const [codexModel, setCodexModel] = usePersisted("mb.newCodexModel", "");
  const [codexEffort, setCodexEffort] = usePersisted("mb.newCodexEffort", "");
  // the models and effort levels the CLIs offer on this Mac (read from the CLIs, not built in)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    window.mb.modelCatalog().then((c: ModelCatalog | { error: string }) => (isErr(c) ? setCatalogError(c.error) : setCatalog(c)));
  }, []);
  const [codexCustom, setCodexCustom] = useState(false);
  useEffect(() => {
    // a saved model the catalog doesn't list is a custom id: show it in the text box
    if (catalog && codexModel && !catalog.codex.models.some((m) => m.id === codexModel)) setCodexCustom(true);
  }, [catalog]);
  const codexInfo = catalog?.codex.models.find((m) => m.id === codexModel);
  const effModel = launch === "codex" ? codexModel.trim() : model === "__custom" ? modelCustom.trim() : model;
  const effEffort = launch === "codex" ? codexEffort : effort;
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<RepoEntry | null>(null);
  const [ticketId, setTicketId] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  // Group + Workspace as two explicit selectors ("workspace" = what the path
  // syntax called a sub-group). Seeded initialGroup ("top" or "top/sub") comes
  // from a workspace's + button; a seeded name that doesn't exist yet lands in
  // the matching "new …" input instead.
  const allTops = useMemo(() => [...new Set(existingGroups.map(topOfKey))], [existingGroups]);
  const subsOf = (top: string) =>
    [...new Set(
      existingGroups
        .filter((g) => g.startsWith(top + "/"))
        .map((g) => splitGroupKey(g).sub)
        .filter((x): x is string => !!x)
    )];
  const seed = initialGroup ? splitGroupKey(initialGroup) : null;
  const [grpSel, setGrpSel] = useState<string>(() =>
    seed ? (allTops.includes(seed.top) ? seed.top : "__new") : ""
  );
  const [grpNew, setGrpNew] = useState(() => (seed && !allTops.includes(seed.top) ? seed.top : ""));
  const [wsSel, setWsSel] = useState<string>(() => {
    if (!seed?.sub) return "";
    return subsOf(seed.top).includes(seed.sub) ? seed.sub : "__new";
  });
  const [wsNew, setWsNew] = useState(() =>
    seed?.sub && !subsOf(seed.top).includes(seed.sub) ? seed.sub : ""
  );
  const effTop = grpSel === "__new" ? sanitizeSegment(grpNew) : grpSel;
  const effSub = wsSel === "__new" ? sanitizeSegment(wsNew) : wsSel;
  const group = effTop ? groupKey(effTop, effSub) : "";
  // Picking a ticket defaults to an isolated worktree under
  // <parent>/worktrees/<repo>/<branch>; unticked, the branch is checked out in
  // the repo itself. An explicit choice is remembered and wins.
  const wtPref = readPref<boolean | null>("mb.newWorktree", null);
  const [useWorktree, setUseWorktreeRaw] = useState<boolean>(wtPref ?? false);
  const setUseWorktree = (v: boolean) => {
    setUseWorktreeRaw(v);
    writePref("mb.newWorktree", v);
  };
  const { isBusy, busy, run, error, setError } = useAction();
  // ADO ticket picker — same flow as the dashboard's Start session. It keeps
  // everyone's tickets: it defaults to yours (identity comes from the PAT) but
  // you can pick up someone else's. Manual entry works without the board.
  const ado = useAdoTickets();
  const allTickets = ado.items ?? [];
  const adoDown = ado.items === null && !!ado.error;
  const [whoPick, setWhoPick] = useState(""); // "" = not picked: yours once known; "*" = anyone
  const who = whoPick || (ado.items ? ado.me || "*" : "");
  const stateOrder = ado.stateOrder;
  const [ticketSel, setTicketSel] = useState("");
  const [sendTicket, setSendTicket] = useState(true);
  // base-branch options follow the chosen repo (new branch is cut off origin/<base>)
  const { branches: branchInfo, base: baseBranch, setBase: setBaseBranch, error: branchError } = useRepoBranches(sel?.path);

  useEffect(() => {
    window.mb.listRepos().then((r: RepoEntry[] | { error: string }) => {
      if (Array.isArray(r)) setRepos(r);
      else setError(`Repo scan failed: ${r.error}`);
    });
  }, []);

  // people who actually have tickets on the board, you first
  const people = useMemo(() => {
    const names = [...new Set(allTickets.map((t) => t.assignedTo).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    const mine = who && who !== "*" ? names.filter((n) => n === who) : [];
    return [...mine, ...names.filter((n) => !mine.includes(n))];
  }, [allTickets, who]);

  const tickets = useMemo(
    () => (who && who !== "*" ? allTickets.filter((t) => t.assignedTo === who) : allTickets),
    [allTickets, who]
  );
  // the Dashboard's column order (when there's no board) leads the picker too
  const columns = useMemo(
    () => ticketsByColumn(tickets, stateOrder, readPref<ColumnPrefs>(COLUMN_PREFS_KEY, legacyColumnPrefs()).states?.order ?? []),
    [tickets, stateOrder]
  );
  const pickable = useMemo(() => columns.flatMap((c) => c.items), [columns]);

  const pickTicket = (val: string) => {
    setTicketSel(val);
    const t = allTickets.find((x) => String(x.id) === val);
    if (t) {
      setTicketId(String(t.id));
      setTicketTitle(suggestTicketName(t.title));
    }
  };

  const filtered = repos.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const branch = ticketId && ticketTitle ? slugBranch(ticketId, ticketTitle) : "";

  // one session per click: a second click while this one is being made would
  // create another session (and worktree)
  const create = async () => {
    if (isBusy()) return;
    const t = allTickets.find((x) => String(x.id) === ticketSel);
    const info = await run("create", () =>
      window.mb.createSession({
        repoPath: sel?.path ?? null,
        ticketId: ticketId || undefined,
        ticketTitle: ticketTitle || undefined,
        taskGroup: group || undefined,
        useWorktree: useWorktree && !!sel,
        ...(sel && baseBranch ? { baseBranch } : {}),
        shell: launch === "shell",
        ...(isAgent ? { agent: launch } : {}),
        ...(isAgent && effModel ? { model: effModel } : {}),
        ...(isAgent && effEffort ? { effort: effEffort } : {}),
        initialPrompt:
          isAgent && t && sendTicket
            ? ticketKickoffPrompt(t.id, t.title, t.description)
            : undefined,
      })
    );
    if (isErr(info)) return;
    onCreated(info);
  };

  return (
    <Modal className="modal" onClose={onClose}>
      <h3>New session</h3>
      <div className="sub-h">Pick a repo, optionally attach a ticket — worktree and branch are handled for you.</div>
      {presets.length > 0 && (
        <div className="preset-chips">
          <span className="pl-dim">Presets</span>
          {presets.map((p) => (
            <button key={p.id} className="outline" data-tip={`Start “${p.name}” now`} onClick={() => onStartPreset(p)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <label>Launch</label>
      <span className="seg" style={{ display: "inline-flex" }}>
        <button className={launch === "claude" ? "on" : ""} onClick={() => setLaunch("claude")}>{AGENT_NAME.claude}</button>
        <button className={launch === "codex" ? "on" : ""} onClick={() => setLaunch("codex")} title="OpenAI Codex CLI — signs in with your ChatGPT subscription">{AGENT_NAME.codex}</button>
        <button className={launch === "shell" ? "on" : ""} onClick={() => setLaunch("shell")}>Terminal</button>
      </span>
      {launch === "codex" && (
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Model</label>
            <Select
              value={codexCustom ? "__custom" : codexModel}
              placeholder={codexModel || "Default"}
              options={[
                { value: "", label: "Default", description: "Whatever codex is set to" },
                ...(catalog?.codex.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
                { value: "__custom", label: "Other model id…", group: "Other" },
              ]}
              onChange={(v) => {
                setCodexCustom(v === "__custom");
                if (v !== "__custom") setCodexModel(v);
              }}
            />
            {codexCustom && (
              <input type="text" placeholder="e.g. gpt-6-luna" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} style={{ marginTop: 6 }} />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label>Reasoning</label>
            <Select
              value={codexEffort}
              options={[
                { value: "", label: codexInfo?.defaultEffort ? `Default (${codexInfo.defaultEffort})` : "Default" },
                ...(codexInfo?.efforts ?? catalog?.codex.efforts ?? ["low", "medium", "high", "xhigh"]).map((e) => ({ value: e, label: e })),
              ]}
              onChange={setCodexEffort}
            />
          </div>
        </div>
      )}
      {launch === "claude" && (
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Model</label>
            <Select
              value={model}
              placeholder={model || "Default"}
              options={[
                { value: "", label: "Default", description: "Whatever claude is set to" },
                ...(catalog?.claude.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
                { value: "__custom", label: "Other model id…", group: "Other" },
              ]}
              onChange={setModel}
            />
            {model === "__custom" && (
              <input
                type="text"
                placeholder="e.g. claude-sonnet-5-5"
                value={modelCustom}
                onChange={(e) => setModelCustom(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label>Effort</label>
            <Select
              value={effort}
              options={[{ value: "", label: "Default" }, ...(catalog?.claude.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map((e) => ({ value: e, label: e }))]}
              onChange={setEffort}
            />
          </div>
        </div>
      )}
      {isAgent && catalogError && (
        <div className="wi-note">Couldn't read the CLI's model list ({catalogError}) — Default and Other model id still work.</div>
      )}
      <label>Repo</label>
      <input type="text" autoFocus placeholder="search ~/Code + ~/Personal Projects…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pick-list">
        {filtered.map((r) => (
          <div key={r.path} className={`item ${sel?.path === r.path ? "sel" : ""}`} onClick={() => setSel(r)}>
            <div className="meta">
              <div className="t">{r.name}</div>
              <div className="s">{tildePath(r.path)}</div>
            </div>
          </div>
        ))}
      </div>
      <label>
        Azure DevOps tickets{" "}
        <span className="wi-note">
          {adoDown
            ? `board unavailable (${ado.error}) — manual entry below`
            : ado.items === null
              ? "loading…"
              : pickable.length
                ? "optional — fills the fields below"
                : "nothing in the working columns — manual entry below"}
          {!adoDown && ado.error ? ` · ${ado.error}` : ""}
        </span>
      </label>
      <div style={{ display: "flex", gap: 10 }}>
        <Pick
          style={{ flex: "0 0 34%" }}
          value={who}
          onChange={(e) => {
            setWhoPick(e.target.value);
            setTicketSel(""); // the old pick may not belong to this person
          }}
          disabled={adoDown || !allTickets.length}
          title="Whose tickets to choose from"
        >
          <option value="*">Anyone</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Pick>
        <Pick
          style={{ flex: 1 }}
          value={ticketSel}
          onChange={(e) => pickTicket(e.target.value)}
          disabled={adoDown || pickable.length === 0}
        >
          <option value="">none / manual</option>
          {columns.map((c) => (
            <optgroup key={c.state} label={c.state}>
              {c.items.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  #{t.id} · {t.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Pick>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label>Ticket #</label>
          <input type="text" placeholder="5038" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
        </div>
        <div style={{ flex: 2 }}>
          <label>Ticket name</label>
          <input type="text" placeholder="filterOrgsByFoundation" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label>Group</label>
          <Pick
            value={grpSel}
            onChange={(e) => {
              setGrpSel(e.target.value);
              setWsSel("");
              setWsNew("");
            }}
          >
            <option value="">
              {ticketId ? `auto — ticket ${ticketIdOf(ticketId)}` : "none"}
            </option>
            {allTops.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="__new">new group…</option>
          </Pick>
          {grpSel === "__new" && (
            <input
              type="text"
              autoFocus
              placeholder="group name"
              value={grpNew}
              onChange={(e) => setGrpNew(e.target.value)}
              style={{ marginTop: 6 }}
            />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <label>
            Workspace
            {effSub && <span className="hint-inline"> → opens as a tab</span>}
          </label>
          <Pick value={wsSel} onChange={(e) => setWsSel(e.target.value)} disabled={!effTop}>
            <option value="">{effTop ? "none — its own pane" : "pick a group first"}</option>
            {(grpSel && grpSel !== "__new" ? subsOf(grpSel) : []).map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            <option value="__new">new workspace…</option>
          </Pick>
          {wsSel === "__new" && (
            <input
              type="text"
              placeholder="workspace name"
              value={wsNew}
              onChange={(e) => setWsNew(e.target.value)}
              style={{ marginTop: 6 }}
            />
          )}
        </div>
      </div>
      <div className="check-line">
        <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} id="wt" />
        <label htmlFor="wt" style={{ margin: 0 }}>
          isolated worktree
          <span className="wi-note">
            {" "}
            {useWorktree
              ? `worktrees/${sel?.name ?? "<repo>"}/${branch || "<branch>"} — its own folder, safe beside other sessions`
              : branch
                ? `off — switches the repo checkout to ${branch}`
                : "off — runs in the repo checkout on its current branch"}
          </span>
        </label>
      </div>
      {sel && branch && branchInfo && branchInfo.branches.length > 0 && (
        <Pick
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          style={{ marginTop: 8 }}
          title="The base is fetched fresh from origin before the new branch is cut"
        >
          <option value="">base: current HEAD</option>
          {branchInfo.branches.map((b) => (
            <option key={b} value={b}>base: origin/{b}</option>
          ))}
        </Pick>
      )}
      {sel && branch && branchError && <div className="wi-note">{branchError} — the branch is cut from the current HEAD</div>}
      {ticketSel && isAgent && (
        <div className="check-line">
          <input type="checkbox" checked={sendTicket} onChange={(e) => setSendTicket(e.target.checked)} id="ntk" />
          <label htmlFor="ntk" style={{ margin: 0 }}>send ticket title + description to {agentLabel}</label>
        </div>
      )}
      {launch === "shell" && !sel && (
        <div className="wi-note" style={{ marginTop: 8 }}>
          no repo picked — the terminal opens in your home folder (pick a repo to open there, or in a worktree)
        </div>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button
          className="outline"
          style={{ marginRight: "auto" }}
          data-tip="Keep this setup as a one-click preset (no ticket: presets are for recurring sessions)"
          onClick={() =>
            onSavePreset({
              id: newPresetId(),
              name: "",
              launch,
              repoPath: sel?.path ?? null,
              // a new branch per run, cut from the same base; otherwise the checkout as it is
              branch: sel && useWorktree && baseBranch ? { mode: "new", pattern: "session-{date}-{time}", base: baseBranch } : { mode: "checkout" },
              useWorktree: !!sel && useWorktree,
              ...(group ? { group } : {}),
              ...(isAgent && effModel ? { model: effModel } : {}),
              ...(isAgent && effEffort ? { effort: effEffort } : {}),
            })
          }
        >
          Save as preset…
        </button>
        <button className="outline" onClick={onClose}>Cancel</button>
        {isAgent && !sel && (
          <span className="wi-note" style={{ marginRight: "auto" }}>
            no repo — starts a plain {agentLabel} chat (fully tracked: resumable, restartable)
          </span>
        )}
        <button className="primary cta" disabled={!!busy} onClick={create}>
          {busy ? "Starting…" : launch === "shell" ? "Open terminal" : sel ? `Start ${agentLabel.toLowerCase()}` : "Start chat"}
        </button>
      </div>
    </Modal>
  );
}

/** A conversation the Import list can open: a recent one, or a search hit. */
interface ImportRow {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  at: number;
  snippet?: string;
  /** Search hits that are already open, or belong to a Collaborate room, aren't imported again. */
  blocked?: string;
  /** A closed Mockingbird session that resumes this conversation — restored rather than duplicated. */
  restore?: string;
}

export function ImportModal({
  onClose,
  onOpened,
  onDone,
}: {
  onClose: () => void;
  onOpened: (opened: SessionInfo[]) => void;
  onDone: () => void;
}) {
  const [convos, setConvos] = useState<ImportableConversation[] | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ImportRow[] | null>(null);
  const [sel, setSel] = useState<Map<string, ImportRow>>(new Map());
  const { busy, run, error, setError } = useAction();

  useEffect(() => {
    window.mb.listImportable().then((r: ImportableConversation[] | { error: string }) => {
      if (isErr(r)) setError(r.error);
      else setConvos(r);
    });
  }, []);

  // typing searches every Claude and Codex conversation on this Mac (the transcript index), any age
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let live = true;
    const t = setTimeout(async () => {
      const r = await window.mb.searchTranscripts(q);
      if (!live) return;
      if (isErr(r)) return setError(r.error);
      setError("");
      setHits(
        (r.hits as TranscriptHit[]).map((h) => ({
          id: h.id,
          agent: h.agent,
          cwd: h.cwd,
          title: h.open.how === "room" ? `${h.open.roomTitle} (Collaborate)` : h.title,
          at: h.updated,
          snippet: h.snippet,
          ...(h.open.how === "pane" ? { blocked: "already open" } : h.open.how === "room" ? { blocked: "in a Collaborate room" } : {}),
          ...(h.open.how === "previous" ? { restore: h.open.sessionId } : {}),
        }))
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const rows: ImportRow[] | null = hits ?? (convos ? convos.map((c) => ({ id: c.sessionId, agent: c.agent ?? ("claude" as AgentKind), cwd: c.cwd, title: c.title, at: c.mtimeMs })) : null);

  const toggle = (r: ImportRow) =>
    setSel((p) => {
      const n = new Map(p);
      n.has(r.id) ? n.delete(r.id) : n.set(r.id, r);
      return n;
    });

  const importSelected = async () => {
    const opened: SessionInfo[] = [];
    const failures: string[] = [];
    const r = await run("import", async () => {
      for (const c of sel.values()) {
        const info = c.restore
          ? await window.mb.relaunchSession(c.restore)
          : await window.mb.createSession({ repoPath: c.cwd, useWorktree: false, resumeSessionId: c.id, agent: c.agent, title: c.title.slice(0, 80) });
        if (!info || isErr(info)) failures.push(`✕ ${c.title.slice(0, 40)}: ${info?.error ?? "that session is no longer saved"}`);
        else opened.push(info);
      }
    });
    if (isErr(r)) failures.push(`✕ ${r.error}`);
    if (opened.length) onOpened(opened);
    if (failures.length) {
      setError(`Opened ${opened.length}, failed ${failures.length}:\n\n${failures.join("\n")}`);
      setSel(new Map());
    } else {
      onDone();
    }
  };

  return (
    <Modal className="modal import-dlg" onClose={onClose}>
      <h3>Import conversations</h3>
      <div className="sub-h">
        Recent Claude and Codex conversations from this Mac — including ones started in cmux or a terminal — or search every one,
        any age. Each reopens with its full history in its original folder. Every import is a live agent process, so start
        with the handful you're actively working on.
      </div>
      <input
        className="import-search"
        type="text"
        autoFocus
        placeholder="Search every conversation — words, files, commands"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="pick-list">
        {rows?.map((c) => (
          <div
            key={c.id}
            className={`item ${sel.has(c.id) ? "sel" : ""} ${c.blocked ? "blocked" : ""}`}
            title={c.blocked ? `Not imported: ${c.blocked}` : c.restore ? "Restores the closed Mockingbird session that ran this" : undefined}
            onClick={() => !c.blocked && toggle(c)}
          >
            <input type="checkbox" checked={sel.has(c.id)} disabled={!!c.blocked} readOnly />
            <div className="meta">
              <div className="t">
                {c.title}
                {c.agent === "codex" && <span className="ts-agent codex">codex</span>}
              </div>
              <div className="s">
                {tildePath(c.cwd)}
                {c.blocked ? ` · ${c.blocked}` : c.restore ? " · restores your closed session" : ""}
              </div>
              {c.snippet && (
                <div className="ts-snip">
                  <Snippet text={c.snippet} />
                </div>
              )}
            </div>
            <span className="age">{agoShort(c.at)}</span>
          </div>
        ))}
        {rows === null && !error && (
          <div className="item"><div className="meta"><div className="s">{q.trim() ? "searching…" : "scanning ~/.claude/projects…"}</div></div></div>
        )}
        {rows?.length === 0 && (
          <div className="item"><div className="meta"><div className="s">{q.trim() ? "No conversation mentions that." : "No recent conversations."}</div></div></div>
        )}
      </div>
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={sel.size === 0 || !!busy} onClick={importSelected}>
          {busy ? "Opening…" : `Open ${sel.size || ""} session${sel.size === 1 ? "" : "s"}`}
        </button>
      </div>
    </Modal>
  );
}
