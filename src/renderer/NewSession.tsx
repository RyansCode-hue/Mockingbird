import { useEffect, useMemo, useRef, useState } from "react";
import { useRepos } from "./RepoPick";
import { Snippet } from "./TranscriptSearch";
import { Pick, Select } from "./Menu";
import { suggestTicketName, ticketKickoffPrompt, ticketsByColumn, useAdoTickets, useRepoBranches } from "./tickets";
import { newPresetId } from "./Presets";
import { isErr, AGENT_NAME, slugBranch, sanitizeSegment, groupKey, ticketIdOf, type AgentKind, type SessionInfo, type SessionPreset, type RepoEntry, type ImportableConversation, type TranscriptHit, type ModelCatalog } from "../shared/types";
import { agoShort } from "../shared/format";
import { tildePath } from "../shared/paths";
import { Modal } from "./Modal";
import { usePersisted, writePref, readPref } from "./prefs";
import { COLUMN_PREFS_KEY, legacyColumnPrefs, type ColumnPrefs } from "./boardView";
import { useAction } from "./useAction";
import { initialsOf } from "./Team";
import { localTops, repoChoices, seedWhere, workspacesOf } from "./newSessionModel";
import type { TeamRoomSummary } from "../shared/team/types";

/** Starting sessions: New session (⌘N) and Import. */

export type LaunchKind = AgentKind | "shell";

export function NewSessionModal({
  existingGroups,
  rooms = [],
  roomRepos = {},
  initialLaunch,
  initialGroup,
  presets,
  onStartPreset,
  onSavePreset,
  onClose,
  onCreated,
}: {
  existingGroups: string[];
  /** Team rooms this Mac is in: a session started in one's group is a connected session. */
  rooms?: TeamRoomSummary[];
  /** The repos each room's sessions work in, by folder name (roomRepoNames), offered first. */
  roomRepos?: Record<string, string[]>;
  initialLaunch?: LaunchKind;
  initialGroup?: string; // "5038" or "5038/backend" — a workspace path adds a tab there; a room's group starts it connected
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

  // Where it goes: a local group (or none), or a team room's group — a
  // connected session, which teammates see live. Group and Workspace are two
  // selectors ("workspace" = what the path syntax calls a sub-group); a seeded
  // name that doesn't exist yet lands in the matching "new …" input instead.
  const seed = seedWhere(initialGroup, rooms);
  const tops = useMemo(() => localTops(existingGroups, rooms), [existingGroups, rooms]);
  const [connected, setConnected] = useState(seed.connected);
  const [roomKey, setRoomKey] = useState(seed.connected ? seed.top : rooms[0]?.groupKey ?? "");
  const room = connected ? rooms.find((r) => r.groupKey === roomKey) ?? null : null;
  const [grpSel, setGrpSel] = useState(() => (seed.connected || !seed.top ? "" : tops.includes(seed.top) ? seed.top : "__new"));
  const [grpNew, setGrpNew] = useState(() => (!seed.connected && seed.top && !tops.includes(seed.top) ? seed.top : ""));
  const top = room ? room.groupKey : grpSel === "__new" ? sanitizeSegment(grpNew) : grpSel;
  const subs = top ? workspacesOf(existingGroups, top) : [];
  const [wsSel, setWsSel] = useState(() => (!seed.sub ? "" : workspacesOf(existingGroups, seed.top).includes(seed.sub) ? seed.sub : "__new"));
  const [wsNew, setWsNew] = useState(() => (seed.sub && !workspacesOf(existingGroups, seed.top).includes(seed.sub) ? seed.sub : ""));
  const effSub = wsSel === "__new" ? sanitizeSegment(wsNew) : wsSel;
  const group = top ? groupKey(top, effSub) : "";
  const resetWorkspace = () => {
    setWsSel("");
    setWsNew("");
  };

  const { repos, error: reposError } = useRepos();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<RepoEntry | null>(null);
  const repoTouched = useRef(false);
  const pickRepo = (r: RepoEntry | null) => {
    repoTouched.current = true;
    setSel(r);
  };
  const suggested = room ? roomRepos[room.groupKey] ?? [] : [];
  const choices = repoChoices(repos, q, suggested);
  // a room working in exactly one repo here starts there, until a repo is picked by hand
  useEffect(() => {
    if (repoTouched.current || sel) return;
    const own = repos.filter((r) => suggested.includes(r.name));
    if (own.length === 1) setSel(own[0]);
  }, [repos, room?.groupKey]);

  const [ticketId, setTicketId] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketOpen, setTicketOpen] = usePersisted("mb.newTicketOpen", false);
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
    if (reposError) setError(`Repo scan failed: ${reposError}`);
  }, [reposError]);

  // people who actually have tickets on the board, you first
  const people = useMemo(() => {
    const names = [...new Set(allTickets.map((t) => t.assignedTo).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const mine = who && who !== "*" ? names.filter((n) => n === who) : [];
    return [...mine, ...names.filter((n) => !mine.includes(n))];
  }, [allTickets, who]);

  const tickets = useMemo(() => (who && who !== "*" ? allTickets.filter((t) => t.assignedTo === who) : allTickets), [allTickets, who]);
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

  const branch = ticketId && ticketTitle ? slugBranch(ticketId, ticketTitle) : "";
  const showTicket = ticketOpen || !!ticketId;

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
        initialPrompt: isAgent && t && sendTicket ? ticketKickoffPrompt(t.id, t.title, t.description) : undefined,
      })
    );
    if (isErr(info)) return;
    onCreated(info);
  };

  // what Start will do, in a line
  const folder = sel
    ? useWorktree
      ? `${sel.name} · new worktree${branch ? ` ${branch}` : ""}`
      : branch
        ? `${sel.name} · checks out ${branch}`
        : `${sel.name} · current branch`
    : launch === "shell"
      ? "home folder"
      : `plain ${agentLabel} chat, no repo`;
  const place = room ? `connected · ${groupKey(room.groupKey, effSub)}` : group ? `in ${group}` : ticketId ? `in ${ticketIdOf(ticketId)}` : "";
  const summary = [folder, place].filter(Boolean).join(" · ");

  const modelPick =
    launch === "codex" ? (
      <>
        <Select
          className="ns-model"
          value={codexCustom ? "__custom" : codexModel}
          placeholder={codexModel || "Default model"}
          title="Model"
          options={[
            { value: "", label: "Default model", description: "Whatever codex is set to" },
            ...(catalog?.codex.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
            { value: "__custom", label: "Other model id…", group: "Other" },
          ]}
          onChange={(v) => {
            setCodexCustom(v === "__custom");
            if (v !== "__custom") setCodexModel(v);
          }}
        />
        <Select
          className="ns-effort"
          value={codexEffort}
          title="Reasoning"
          options={[
            { value: "", label: codexInfo?.defaultEffort ? `Default (${codexInfo.defaultEffort})` : "Default reasoning" },
            ...(codexInfo?.efforts ?? catalog?.codex.efforts ?? ["low", "medium", "high", "xhigh"]).map((e) => ({ value: e, label: e })),
          ]}
          onChange={setCodexEffort}
        />
      </>
    ) : launch === "claude" ? (
      <>
        <Select
          className="ns-model"
          value={model}
          placeholder={model || "Default model"}
          title="Model"
          options={[
            { value: "", label: "Default model", description: "Whatever claude is set to" },
            ...(catalog?.claude.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description, group: m.group })),
            { value: "__custom", label: "Other model id…", group: "Other" },
          ]}
          onChange={setModel}
        />
        <Select
          className="ns-effort"
          value={effort}
          title="Effort"
          options={[{ value: "", label: "Default effort" }, ...(catalog?.claude.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map((e) => ({ value: e, label: e }))]}
          onChange={setEffort}
        />
      </>
    ) : null;
  const customModel =
    launch === "codex" && codexCustom ? (
      <input type="text" placeholder="model id, e.g. gpt-6-luna" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} />
    ) : launch === "claude" && model === "__custom" ? (
      <input type="text" placeholder="model id, e.g. claude-sonnet-5-5" value={modelCustom} onChange={(e) => setModelCustom(e.target.value)} />
    ) : null;

  return (
    <Modal
      className="modal ns"
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void create();
        }
      }}
    >
      <div className="ns-head">
        <h3>New session</h3>
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
      </div>

      <div className="ns-body">
        <section className="ns-sec">
          <div className="ns-k">Run</div>
          <div>
            <div className="ns-line">
              <span className="seg ns-launch">
                <button className={launch === "claude" ? "on" : ""} onClick={() => setLaunch("claude")}>{AGENT_NAME.claude}</button>
                <button className={launch === "codex" ? "on" : ""} onClick={() => setLaunch("codex")} title="OpenAI Codex CLI — signs in with your ChatGPT subscription">{AGENT_NAME.codex}</button>
                <button className={launch === "shell" ? "on" : ""} onClick={() => setLaunch("shell")}>Terminal</button>
              </span>
              {modelPick}
            </div>
            {customModel && <div className="ns-line ns-gap">{customModel}</div>}
            {isAgent && catalogError && <div className="wi-note">Couldn't read the CLI's model list ({catalogError}) — Default and Other model id still work.</div>}
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-k">Where</div>
          <div>
            <span className="seg ns-where">
              <button className={!connected ? "on" : ""} onClick={() => (setConnected(false), resetWorkspace())}>Local</button>
              <button
                className={connected ? "on" : ""}
                disabled={!rooms.length}
                title={rooms.length ? "A session in a team room: teammates see it live and can type into it" : "Share a group (⇪ on its header) or join a team room (⇲) to start connected sessions"}
                onClick={() => (setConnected(true), resetWorkspace())}
              >
                Connected{rooms.length ? ` · ${rooms.length}` : ""}
              </button>
            </span>
            {connected ? (
              <>
                <div className="ns-rooms" role="radiogroup">
                  {rooms.map((r) => {
                    const online = r.members.filter((m) => r.online.includes(m.id));
                    return (
                      <button
                        key={r.id}
                        role="radio"
                        aria-checked={r.groupKey === roomKey}
                        className={`ns-room ${r.groupKey === roomKey ? "sel" : ""}`}
                        onClick={() => (setRoomKey(r.groupKey), resetWorkspace())}
                      >
                        <span className="meta">
                          <span className="t">{r.name}</span>
                          <span className="s">
                            group {r.groupKey}
                            {(roomRepos[r.groupKey] ?? []).length ? ` · ${(roomRepos[r.groupKey] ?? []).join(", ")}` : ""}
                          </span>
                        </span>
                        <span className="ns-people" title={online.length ? `Connected now: ${online.map((m) => m.name).join(", ")}` : "No teammate connected right now"}>
                          {r.members
                            .filter((m) => !m.self)
                            .map((m) => (
                              <span key={m.id} className={`team-initials ${r.online.includes(m.id) ? "" : "off"}`}>
                                {initialsOf(m.name)}
                              </span>
                            ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <WorkspacePick subs={subs} value={wsSel} newName={wsNew} onChange={setWsSel} onNewName={setWsNew} />
                <div className="ns-note">Teammates in the room see this session live and can type into it. Its agent can't read .env files, keys or logins, and can't push.</div>
              </>
            ) : (
              <div className="ns-line ns-gap">
                <div className="grow">
                  <Pick
                    value={grpSel}
                    title="Group"
                    onChange={(e) => {
                      setGrpSel(e.target.value);
                      resetWorkspace();
                    }}
                  >
                    <option value="">{ticketId ? `group: auto — ticket ${ticketIdOf(ticketId)}` : "no group"}</option>
                    {tops.map((t) => (
                      <option key={t} value={t}>
                        group: {t}
                      </option>
                    ))}
                    <option value="__new">new group…</option>
                  </Pick>
                  {grpSel === "__new" && <input type="text" autoFocus placeholder="group name" value={grpNew} onChange={(e) => setGrpNew(e.target.value)} />}
                </div>
                <div className="grow">
                  <WorkspacePick subs={subs} value={wsSel} newName={wsNew} onChange={setWsSel} onNewName={setWsNew} disabled={!top} inline />
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-k">Repo</div>
          <div>
            {sel ? (
              <div className="ns-chosen">
                <span className="meta">
                  <span className="t">{sel.name}</span>
                  <span className="s">{tildePath(sel.path)}</span>
                </span>
                <button className="outline" onClick={() => (pickRepo(null), setQ(""))}>Change</button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  autoFocus
                  placeholder={launch === "shell" ? "search repos — or leave empty for your home folder" : `search repos — or leave empty for a plain ${agentLabel} chat`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && choices[0]) pickRepo(choices[0].repo);
                  }}
                />
                {choices.length > 0 && (
                  <div className="pick-list ns-list">
                    {choices.map(({ repo, suggested: own }) => (
                      <div key={repo.path} className="item" onClick={() => pickRepo(repo)}>
                        <div className="meta">
                          <div className="t">{repo.name}</div>
                          <div className="s">{tildePath(repo.path)}</div>
                        </div>
                        {own && <span className="ns-tag">in this room</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {sel && (
              <>
                <div className="check-line">
                  <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} id="wt" />
                  <label htmlFor="wt" className="ns-check">
                    Isolated worktree
                    <span className="wi-note">
                      {" "}
                      {useWorktree
                        ? `worktrees/${sel.name}/${branch || "<branch>"} — its own folder, safe beside other sessions`
                        : branch
                          ? `off — switches the repo checkout to ${branch}`
                          : "off — runs in the repo checkout on its current branch"}
                    </span>
                  </label>
                </div>
                {branch && branchInfo && branchInfo.branches.length > 0 && (
                  <Pick value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} style={{ marginTop: 8 }} title="The base is fetched fresh from origin before the new branch is cut">
                    <option value="">base: current HEAD</option>
                    {branchInfo.branches.map((b) => (
                      <option key={b} value={b}>
                        base: origin/{b}
                      </option>
                    ))}
                  </Pick>
                )}
                {branch && branchError && <div className="wi-note">{branchError} — the branch is cut from the current HEAD</div>}
              </>
            )}
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-k">Ticket</div>
          <div>
            <div className="ns-line">
              <span className="ns-ticket-sum">
                {ticketId ? `#${ticketIdOf(ticketId)}${ticketTitle ? ` · ${ticketTitle}` : ""}` : <span className="pl-dim">none</span>}
              </span>
              {!ticketId && (
                <button className="link" onClick={() => setTicketOpen(!ticketOpen)}>
                  {ticketOpen ? "Hide" : "Attach a ticket"}
                </button>
              )}
              {ticketId && (
                <button
                  className="link"
                  onClick={() => {
                    setTicketId("");
                    setTicketTitle("");
                    setTicketSel("");
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {showTicket && (
              <>
                <div className="ns-line ns-gap">
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
                  <Pick style={{ flex: 1 }} value={ticketSel} onChange={(e) => pickTicket(e.target.value)} disabled={adoDown || pickable.length === 0} title="Azure DevOps tickets">
                    <option value="">{adoDown ? "board unavailable — type it below" : ado.items === null ? "loading the board…" : pickable.length ? "pick from the board…" : "nothing in the working columns"}</option>
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
                {ado.error && <div className="wi-note">{adoDown ? `Azure DevOps: ${ado.error}` : ado.error}</div>}
                <div className="ns-line ns-gap">
                  <input type="text" style={{ flex: 1 }} placeholder="ticket #, e.g. 5038" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
                  <input type="text" style={{ flex: 2 }} placeholder="name, e.g. filterOrgsByFoundation" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
                </div>
                {ticketSel && isAgent && (
                  <div className="check-line">
                    <input type="checkbox" checked={sendTicket} onChange={(e) => setSendTicket(e.target.checked)} id="ntk" />
                    <label htmlFor="ntk" className="ns-check">
                      send the ticket's title and description to {agentLabel}
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="ns-foot">
        <button
          className="ns-ghost"
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
        <span className="ns-sum" title={summary}>
          {summary}
        </span>
        <button className="outline" onClick={onClose}>
          Cancel
        </button>
        <button className="primary cta" disabled={!!busy} onClick={create} data-tip="⌘↵">
          {busy ? "Starting…" : launch === "shell" ? "Open terminal" : `Start ${agentLabel}`}
        </button>
      </div>
    </Modal>
  );
}

/** A group's workspace: none (its own pane), an existing one, or a new one by name. */
function WorkspacePick({
  subs,
  value,
  newName,
  onChange,
  onNewName,
  disabled,
  inline,
}: {
  subs: string[];
  value: string;
  newName: string;
  onChange: (v: string) => void;
  onNewName: (v: string) => void;
  disabled?: boolean;
  /** Beside the group picker, rather than on its own line under the room list. */
  inline?: boolean;
}) {
  return (
    <div className={inline ? "" : "ns-gap"}>
      <Pick value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} title="Workspace: sessions in one open as tabs of a single pane">
        <option value="">{disabled ? "workspace: pick a group first" : "workspace: none — its own pane"}</option>
        {subs.map((w) => (
          <option key={w} value={w}>
            workspace: {w} → opens as a tab
          </option>
        ))}
        <option value="__new">new workspace…</option>
      </Pick>
      {value === "__new" && <input type="text" placeholder="workspace name" value={newName} onChange={(e) => onNewName(e.target.value)} />}
    </div>
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
