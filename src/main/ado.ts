import * as fs from "fs";
import * as path from "path";
import { Store, expandHome } from "./store";
import { AdoWorkItem, AdoComment, AdoBoard } from "../shared/types";

interface AdoConfig {
  orgUrl: string;
  project: string;
  pat: string;
  team?: string; // azureDevOps.team; the project's default team when unset
}

/**
 * Reads ADO connection info from the WorkTracker folder's config.json.
 * The PAT lives in a separate file referenced by azureDevOps.patFile and is
 * only ever read here in the main process — it is never sent to the renderer.
 */
function loadAdoConfig(store: Store): AdoConfig {
  const wt = expandHome(store.settings.workTrackerPath);
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(wt, "config.json"), "utf8"));
  } catch (err) {
    throw new Error(`Couldn't read ${wt}/config.json: ${err instanceof Error ? err.message : err}`);
  }
  const ado = cfg.azureDevOps;
  if (!ado?.orgUrl || !ado?.project) {
    throw new Error("WorkTracker config.json needs azureDevOps.orgUrl and azureDevOps.project");
  }
  if (!ado.patFile) {
    throw new Error("WorkTracker config.json needs azureDevOps.patFile (path to a file containing the PAT)");
  }
  const patPath = path.isAbsolute(ado.patFile) ? ado.patFile : path.join(wt, ado.patFile);
  let pat: string;
  try {
    pat = fs.readFileSync(patPath, "utf8").trim();
  } catch (err) {
    throw new Error(`Couldn't read PAT file ${patPath}: ${err instanceof Error ? err.message : err}`);
  }
  if (!pat) throw new Error(`PAT file ${patPath} is empty`);
  return { orgUrl: String(ado.orgUrl).replace(/\/+$/, ""), project: String(ado.project), pat, ...(ado.team ? { team: String(ado.team) } : {}) };
}

const ADO_TIMEOUT_MS = 30_000;

/** A request with the PAT, cut off after 30s — a dead VPN would otherwise hold it for minutes. */
async function adoFetch(cfg: AdoConfig, url: string, init?: RequestInit): Promise<any> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: "Basic " + Buffer.from(":" + cfg.pat).toString("base64"),
        ...((init?.headers as Record<string, string>) ?? {}),
      },
      signal: AbortSignal.timeout(ADO_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Azure DevOps ${res.status} ${res.statusText}: ${body}`);
    }
    return await res.json();
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error(`Azure DevOps didn't answer within ${ADO_TIMEOUT_MS / 1000}s — check the org URL, or your VPN`);
    throw err;
  }
}

/** An authenticated request to any Azure DevOps URL with the configured PAT (pull requests live per repository, not per project). */
export async function adoRequest(store: Store, url: string, init?: RequestInit): Promise<any> {
  return adoFetch(loadAdoConfig(store), url, init);
}

/** The REST API version every call uses, except the comments API, which is only in preview. */
export const ADO_API = "api-version=7.0";
const COMMENTS_API = "api-version=7.1-preview.3";

/** A call to the project's work-item API; `rest` follows `_apis/wit/` and carries its api-version. */
function wit(cfg: AdoConfig, rest: string, init?: RequestInit): Promise<any> {
  return adoFetch(cfg, `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/${rest}`, init);
}

/** Change a work item's fields with JSON-Patch operations. */
function patchWorkItem(cfg: AdoConfig, id: number, ops: { op: string; path: string; value: string }[]): Promise<any> {
  return wit(cfg, `workitems/${id}?${ADO_API}`, { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) });
}

/** Plain text as ADO's HTML fields and comments expect it: escaped, one <div> per line so line breaks survive. */
function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((l) => `<div>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</div>`)
    .join("");
}

/** ADO descriptions are HTML; flatten to editable plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    // last, or the "&lt;" in an escaped "&amp;lt;" would be decoded a second time
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Who the configured PAT belongs to — shown in Settings so users can verify
 * their identity, and what setup's "connected" rests on, so a failure throws.
 */
export async function adoIdentity(store: Store): Promise<{ display: string; email: string; org: string; project: string }> {
  const cfg = loadAdoConfig(store);
  const me = await connectionIdentity(cfg);
  return { ...me, org: cfg.orgUrl, project: cfg.project };
}

// PAT owner's identity — drives the board's default "Assigned to: Me" filter.
// Display name AND email, because ADO sometimes spells connectionData's display
// name differently than System.AssignedTo on work items; email is the stable key.
let cachedMe: { display: string; email: string } | null = null;
let boardsCache: { at: number; value: { team: string; boards: AdoBoard[] } } | null = null;
/** Drop cached identity after the ADO connector config changes. */
export function resetAdoCache(): void {
  cachedMe = null;
  boardsCache = null;
}
async function connectionIdentity(cfg: AdoConfig): Promise<{ display: string; email: string }> {
  const r = await adoFetch(cfg, `${cfg.orgUrl}/_apis/connectionData`);
  const me = {
    display: r.authenticatedUser?.providerDisplayName ?? "",
    email: r.authenticatedUser?.properties?.Account?.$value ?? "",
  };
  if (!me.display && !me.email) throw new Error("Azure DevOps didn't say who the PAT belongs to — it may have expired");
  cachedMe = me;
  return me;
}
/** The PAT owner for the board's "me", or no one when that can't be resolved right now (logged). */
async function whoAmI(cfg: AdoConfig): Promise<{ display: string; email: string }> {
  if (cachedMe) return cachedMe;
  try {
    return await connectionIdentity(cfg);
  } catch (err) {
    // do NOT cache the failure: one network blip would otherwise disable "me"
    // (board filter, my-tickets picker, debrief snapshot) for the whole run
    console.error("[mockingbird] ADO connectionData failed, identity unresolved:", err);
    return { display: "", email: "" };
  }
}

/**
 * The project's work items for the board, with `me`, the PAT owner's name as
 * the items spell it (empty when unresolved), for its "Assigned to: Me"
 * filter. Non-Removed states, plus the last two weeks of closed items so the
 * board's terminal columns aren't empty and cards can be dragged back out.
 * The batch API caps at 200 ids — `total` reports the real match count so the
 * UI can say "200 of N" instead of silently truncating.
 */
export async function listWorkItems(store: Store): Promise<{ items: AdoWorkItem[]; total: number; me: string }> {
  const cfg = loadAdoConfig(store);
  const wiql = {
    query:
      "SELECT [System.Id] FROM WorkItems " +
      "WHERE [System.State] <> 'Removed' " +
      "AND [System.WorkItemType] NOT IN ('Test Case', 'Test Plan', 'Test Suite') " +
      "AND ([System.State] NOT IN ('Closed', 'Done') OR [System.ChangedDate] >= @Today - 14) " +
      "ORDER BY [System.ChangedDate] DESC",
  };
  const q = await wit(cfg, `wiql?${ADO_API}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wiql),
  });
  const meIds = await whoAmI(cfg);
  const all: number[] = (q.workItems ?? []).map((w: any) => w.id);
  const ids = all.slice(0, 200);
  if (!ids.length) return { items: [], total: all.length, me: meIds.display };
  const fields = [
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.ChangedDate",
    "System.Description",
    "System.BoardColumn",
  ].join(",");
  const r = await wit(cfg, `workitems?ids=${ids.join(",")}&fields=${fields}&${ADO_API}`);
  const items = (r.value ?? []).map((v: any): AdoWorkItem => ({
    id: v.id,
    title: v.fields["System.Title"] ?? "",
    state: v.fields["System.State"] ?? "",
    type: v.fields["System.WorkItemType"] ?? "",
    assignedTo: v.fields["System.AssignedTo"]?.displayName ?? "",
    changed: v.fields["System.ChangedDate"] ?? "",
    description: htmlToText(v.fields["System.Description"] ?? ""),
    ...(v.fields["System.BoardColumn"] ? { boardColumn: String(v.fields["System.BoardColumn"]) } : {}),
    url: `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_workitems/edit/${v.id}`,
  }));
  // resolve "me" to the exact spelling the work items use (match by email first,
  // then case-insensitive name) so the filter actually matches the cards
  const identities: { display: string; email: string }[] = (r.value ?? []).map((v: any) => ({
    display: v.fields["System.AssignedTo"]?.displayName ?? "",
    email: v.fields["System.AssignedTo"]?.uniqueName ?? "",
  }));
  const emailMatch = meIds.email
    ? identities.find((p) => p.email && p.email.toLowerCase() === meIds.email.toLowerCase())
    : undefined;
  const nameMatch = meIds.display
    ? identities.find((p) => p.display && p.display.toLowerCase() === meIds.display.toLowerCase())
    : undefined;
  const me = emailMatch?.display || nameMatch?.display || meIds.display;
  return { items, total: all.length, me };
}

/** Valid states for a work item type (drives the state dropdown). */
export async function workItemStates(store: Store, type: string): Promise<string[]> {
  const cfg = loadAdoConfig(store);
  const r = await wit(cfg, `workitemtypes/${encodeURIComponent(type)}/states?${ADO_API}`);
  return (r.value ?? []).map((s: any) => s.name);
}

/**
 * Live ADO snapshot for the debriefs — the PAT owner's open work items with
 * states, descriptions, and recent comments, written to
 * <workTracker>/session-digests/ado-snapshot-<date>.md via the REST API.
 * Lets the wrap-up/morning sessions get ticket truth even when Claude Code
 * has no ADO connector configured. PR review votes are NOT included.
 */
export async function writeAdoSnapshot(store: Store): Promise<{ file: string; count: number }> {
  const { items, me } = await listWorkItems(store);
  // with no "me", the filter below would pick the unassigned items
  if (!me) throw new Error("Couldn't tell who the PAT belongs to, so there's no knowing which work items are yours");
  const mine = items
    .filter((i) => i.assignedTo === me && !["Closed", "Done", "Removed"].includes(i.state))
    .slice(0, 15);
  const dir = path.join(expandHome(store.settings.workTrackerPath), "session-digests");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `ado-snapshot-${date}.md`);
  const parts = [
    `# Azure DevOps snapshot — ${date}`,
    `Generated ${new Date().toLocaleTimeString()} for ${me} via the ADO REST API. ` +
      `States and comments are live as of this timestamp. PR review votes are not included.`,
  ];
  for (const it of mine) {
    parts.push(
      `\n## #${it.id} · ${it.title}`,
      `state: ${it.state} · type: ${it.type} · last changed: ${it.changed}`,
      it.description.trim() ? it.description.trim().slice(0, 600) : "(no description)"
    );
    try {
      const comments = (await listComments(store, it.id)).slice(-3);
      for (const c of comments) {
        parts.push(`> ${c.author} (${c.date.slice(0, 10)}): ${c.text.slice(0, 300)}`);
      }
    } catch (err) {
      parts.push(`> (comments unavailable: ${err instanceof Error ? err.message : err})`);
    }
  }
  if (!mine.length) parts.push("\n(no open work items assigned)");
  fs.writeFileSync(file, parts.join("\n"));
  return { file, count: mine.length };
}

/**
 * Env vars for Mockingbird-spawned debrief sessions: the az DevOps CLI
 * extension authenticates via AZURE_DEVOPS_EXT_PAT, so `az boards`/`az repos`
 * work in the debrief without `az login` or an MCP server. Returns {} when
 * ADO isn't configured or its config can't be read (logged) — the session
 * just runs without it.
 */
export function adoEnv(store: Store): Record<string, string> {
  try {
    const cfg = loadAdoConfig(store);
    return { AZURE_DEVOPS_EXT_PAT: cfg.pat };
  } catch (err) {
    // loadAdoConfig's errors name files, never the PAT itself
    console.error("[mockingbird] debrief starts without Azure DevOps access:", (err as Error).message);
    return {};
  }
}

/** Discussion thread for a work item, oldest first. */
export async function listComments(store: Store, id: number): Promise<AdoComment[]> {
  const cfg = loadAdoConfig(store);
  const r = await wit(cfg, `workItems/${id}/comments?${COMMENTS_API}`);
  return (r.comments ?? [])
    .map((c: any): AdoComment => ({
      id: c.id,
      author: c.createdBy?.displayName ?? "unknown",
      date: c.createdDate ?? "",
      text: htmlToText(c.text ?? ""),
    }))
    .sort((a: AdoComment, b: AdoComment) => a.date.localeCompare(b.date));
}

/** Post a user-authored comment to the work item's discussion. */
export async function addComment(store: Store, id: number, text: string): Promise<AdoComment> {
  const cfg = loadAdoConfig(store);
  const r = await wit(cfg, `workItems/${id}/comments?${COMMENTS_API}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: textToHtml(text) }),
  });
  return {
    id: r.id,
    author: r.createdBy?.displayName ?? "me",
    date: r.createdDate ?? new Date().toISOString(),
    text: htmlToText(r.text ?? text),
  };
}

/** Apply user-initiated edits (title / state / description) as a JSON-Patch. */
export async function updateWorkItem(
  store: Store,
  id: number,
  patch: { title?: string; state?: string; description?: string }
): Promise<{ id: number }> {
  const cfg = loadAdoConfig(store);
  const ops: { op: string; path: string; value: string }[] = [];
  if (patch.title != null) ops.push({ op: "add", path: "/fields/System.Title", value: patch.title });
  if (patch.state != null) ops.push({ op: "add", path: "/fields/System.State", value: patch.state });
  if (patch.description != null) {
    ops.push({ op: "add", path: "/fields/System.Description", value: textToHtml(patch.description) });
  }
  if (!ops.length) throw new Error("Nothing to update");
  const r = await patchWorkItem(cfg, id, ops);
  return { id: r.id };
}

const BOARDS_TTL_MS = 10 * 60_000;

/**
 * The team's boards — their columns, the state each work item type has in each
 * column, and the Kanban column field — so the Dashboard shows the board the
 * team really uses rather than raw states. Team: azureDevOps.team, else the
 * project's default team.
 */
export async function teamBoards(store: Store, fresh = false): Promise<{ team: string; boards: AdoBoard[] }> {
  if (!fresh && boardsCache && Date.now() - boardsCache.at < BOARDS_TTL_MS) return boardsCache.value;
  const cfg = loadAdoConfig(store);
  const project = encodeURIComponent(cfg.project);
  let team = cfg.team;
  if (!team) {
    const p = await adoFetch(cfg, `${cfg.orgUrl}/_apis/projects/${project}?${ADO_API}`);
    team = p.defaultTeam?.name;
    if (!team) throw new Error(`Project ${cfg.project} has no default team — set azureDevOps.team in the WorkTracker config.json`);
  }
  const tbase = `${cfg.orgUrl}/${project}/${encodeURIComponent(team!)}`;
  const list = await adoFetch(cfg, `${tbase}/_apis/work/boards?${ADO_API}`);
  const boards: AdoBoard[] = await Promise.all(
    (list.value ?? []).map(async (b: any) => {
      const d = await adoFetch(cfg, `${tbase}/_apis/work/boards/${b.id}?${ADO_API}`);
      return {
        id: String(b.id),
        name: String(b.name),
        columnField: d.fields?.columnField?.referenceName ?? null,
        columns: (d.columns ?? []).map((c: any) => ({ name: String(c.name), type: c.columnType, stateMappings: c.stateMappings ?? {} })),
      };
    })
  );
  const value = { team: team!, boards };
  boardsCache = { at: Date.now(), value };
  return value;
}

/**
 * Move a work item to a board column: its state becomes the column's state for
 * its type, and the Kanban column field is set, which is what tells columns
 * that share a state (Idea / Approved / Planning) apart.
 */
export async function moveToBoardColumn(store: Store, id: number, type: string, boardName: string, column: string): Promise<{ id: number; state: string }> {
  const { boards } = await teamBoards(store);
  const board = boards.find((b) => b.name === boardName);
  if (!board) throw new Error(`The ${boardName} board wasn't found`);
  const col = board.columns.find((c) => c.name === column);
  const state = col?.stateMappings[type];
  if (!col || !state) throw new Error(`A ${type} can't go in ${column} on the ${boardName} board`);
  const cfg = loadAdoConfig(store);
  const ops = [{ op: "add", path: "/fields/System.State", value: state }];
  if (board.columnField) ops.push({ op: "add", path: `/fields/${board.columnField}`, value: column });
  const r = await patchWorkItem(cfg, id, ops);
  return { id: r.id, state };
}
