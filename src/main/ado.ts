import * as fs from "fs";
import * as path from "path";
import { Store, expandHome } from "./store";
import { AdoWorkItem, AdoComment } from "../shared/types";

interface AdoConfig {
  orgUrl: string;
  project: string;
  pat: string;
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
  return { orgUrl: String(ado.orgUrl).replace(/\/+$/, ""), project: String(ado.project), pat };
}

async function adoFetch(cfg: AdoConfig, url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(":" + cfg.pat).toString("base64"),
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Azure DevOps ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

/** ADO descriptions are HTML; flatten to editable plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const API = "api-version=7.0";

/** Who the configured PAT belongs to — shown in Settings so users can verify their identity. */
export async function adoIdentity(store: Store): Promise<{ display: string; email: string; org: string; project: string }> {
  const cfg = loadAdoConfig(store);
  const me = await whoAmI(cfg);
  return { ...me, org: cfg.orgUrl, project: cfg.project };
}

// PAT owner's identity — drives the board's default "Assigned to: Me" filter.
// Display name AND email, because ADO sometimes spells connectionData's display
// name differently than System.AssignedTo on work items; email is the stable key.
let cachedMe: { display: string; email: string } | null = null;
/** Drop cached identity after the ADO connector config changes. */
export function resetAdoCache(): void {
  cachedMe = null;
}
async function whoAmI(cfg: AdoConfig): Promise<{ display: string; email: string }> {
  if (cachedMe) return cachedMe;
  try {
    const r = await adoFetch(cfg, `${cfg.orgUrl}/_apis/connectionData`);
    cachedMe = {
      display: r.authenticatedUser?.providerDisplayName ?? "",
      email: r.authenticatedUser?.properties?.Account?.$value ?? "",
    };
    return cachedMe;
  } catch (err) {
    // do NOT cache the failure: one network blip would otherwise disable "me"
    // (board filter, my-tickets picker, debrief snapshot) for the whole run
    console.error("[mockingbird] ADO connectionData failed, identity unresolved:", err);
    return { display: "", email: "" };
  }
}

/**
 * Board work items. scope "me" = assigned to the PAT's owner; "all" = the whole
 * project. Always: non-Removed states, plus the last two weeks of closed items
 * so the board's terminal columns aren't empty and cards can be dragged back out.
 * The batch API caps at 200 ids — `total` reports the real match count so the
 * UI can say "200 of N" instead of silently truncating.
 */
export async function listWorkItems(
  store: Store,
  _scope?: string // kept for IPC compatibility; the board always loads the project
): Promise<{ items: AdoWorkItem[]; total: number; me: string }> {
  const cfg = loadAdoConfig(store);
  const base = `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}`;
  const wiql = {
    query:
      "SELECT [System.Id] FROM WorkItems " +
      "WHERE [System.State] <> 'Removed' " +
      "AND [System.WorkItemType] NOT IN ('Test Case', 'Test Plan', 'Test Suite') " +
      "AND ([System.State] NOT IN ('Closed', 'Done') OR [System.ChangedDate] >= @Today - 14) " +
      "ORDER BY [System.ChangedDate] DESC",
  };
  const q = await adoFetch(cfg, `${base}/_apis/wit/wiql?${API}`, {
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
  ].join(",");
  const r = await adoFetch(cfg, `${base}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields}&${API}`);
  const items = (r.value ?? []).map((v: any): AdoWorkItem => ({
    id: v.id,
    title: v.fields["System.Title"] ?? "",
    state: v.fields["System.State"] ?? "",
    type: v.fields["System.WorkItemType"] ?? "",
    assignedTo: v.fields["System.AssignedTo"]?.displayName ?? "",
    changed: v.fields["System.ChangedDate"] ?? "",
    description: htmlToText(v.fields["System.Description"] ?? ""),
    url: `${base}/_workitems/edit/${v.id}`,
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
  const r = await adoFetch(
    cfg,
    `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?${API}`
  );
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
  const mine = items
    .filter((i) => i.assignedTo === me && !["Closed", "Done", "Removed"].includes(i.state))
    .slice(0, 15);
  const dir = path.join(expandHome(store.settings.workTrackerPath), "session-digests");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `ado-snapshot-${date}.md`);
  const parts = [
    `# Azure DevOps snapshot — ${date}`,
    `Generated ${new Date().toLocaleTimeString()} for ${me || "(unknown identity)"} via the ADO REST API. ` +
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
 * ADO isn't configured — the session just runs without it.
 */
export function adoEnv(store: Store): Record<string, string> {
  try {
    const cfg = loadAdoConfig(store);
    return { AZURE_DEVOPS_EXT_PAT: cfg.pat };
  } catch {
    return {};
  }
}

/** Discussion thread for a work item, oldest first. */
export async function listComments(store: Store, id: number): Promise<AdoComment[]> {
  const cfg = loadAdoConfig(store);
  const r = await adoFetch(
    cfg,
    `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`
  );
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
  const r = await adoFetch(
    cfg,
    `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }
  );
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
    // plain text goes back as simple HTML paragraphs
    const html = patch.description
      .split("\n")
      .map((l) => `<div>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</div>`)
      .join("");
    ops.push({ op: "add", path: "/fields/System.Description", value: html });
  }
  if (!ops.length) throw new Error("Nothing to update");
  const r = await adoFetch(
    cfg,
    `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?${API}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(ops),
    }
  );
  return { id: r.id };
}
