import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { MB_DIR } from "./store";
import type { SessionManager } from "./sessions";
import { SessionInfo, topOfKey, type AgentKind, type AgentMessage, type SessionStatus } from "../shared/types";
import { writeGenerated } from "./fileOps";
import { HOUSE_TOOL_SCHEMAS, isHouseTool } from "./team/houseTools";
import { houseToolCall } from "./team/houseService";
import { ARTIFACT_TOOL } from "../shared/team/artifacts";
import { named, plainLine, quoted } from "../shared/team/agentText";
import { ARTIFACT_TOOL_SCHEMAS, artifactToolCall } from "./team/artifactTools";
import { isTeamChangesTool, TEAM_CHANGES_TOOL_SCHEMAS, teamChangesToolCall } from "./team/teamChanges";
import { outsideRoomSandbox, parseRemoteId, remoteSessionId, ROOM_SANDBOX_REFUSAL } from "../shared/team/livePanes";
import { ROOMS_STARTING } from "../shared/wires";
import { McpTokens } from "./mcpTokens";
import { isTicketTool, TICKET_TOOL_SCHEMAS } from "./ticketToolSchemas";
import { isWireTool, WIRE_TOOL_SCHEMAS } from "./wireToolSchemas";
import { systemPeerCheck, type PeerCheck } from "./peerCheck";
import { ASSISTANT_CALLER_PREFIX, ASSISTANT_LIST_OP, isAssistantCaller } from "./assistant/caller";

const SOCK = path.join(MB_DIR, "mb.sock");
const MCP_SCRIPT = path.join(MB_DIR, "mcp.js");
/**
 * Every launch's token, for as long as the launch runs. In HOME_SECRETS: a Codex room session's sandbox denies it to
 * the agent's commands; a Claude room session's deny rules cover only Claude's file tools, not its shell.
 */
const TOKENS_DIR = path.join(MB_DIR, "mcp-tokens");
const tokens = new McpTokens(TOKENS_DIR);
const systemPeers = systemPeerCheck();

/**
 * What an agent is told when its tool server has no valid token: why, and that the user has heard. It suggests no
 * restart: a server whose launch has ended gets nothing from starting again, and one a sandbox keeps from its token
 * file can't read it the next time either.
 */
const noTokenText = (why: string): string =>
  `Mockingbird doesn't recognise this tool server, so its tools can't be used from here: ${why}. ` +
  "They work for an agent Mockingbird started in a workspace, for as long as that launch runs. Mockingbird has logged this for the user; tell them if you need these tools.";

/**
 * Why a tool server has no usable token, in Mockingbird's words, from the code it sent (`lost`); null for a code this
 * build doesn't know. `current` is whether its token file is its pane's running launch's.
 */
function lostReason(code: unknown, current: boolean): string | null {
  if (code === "nofile") return "it was started without a token file";
  if (code === "empty") return "its token file is empty";
  if (code === "enoent") return current ? "its token file was removed while its launch runs" : "its token file is gone, as it is once the launch it was made for has ended (its workspace was closed or restarted)";
  const read = typeof code === "string" ? /^read:([A-Z][A-Z0-9_]{0,23})$/.exec(code) : null;
  return read ? `its token file couldn't be read (${read[1]})` : null;
}

/** What a caller refused by the process check (W20) is told to do next, by why it was refused. */
const CALLER_NEXT = {
  failed: "This is usually brief: try the call again in a moment. If it keeps failing, tell your user; Mockingbird has logged it for them.",
  gone: "That launch is over, so its tools have stopped. If the workspace is still open, your user can restart it in Mockingbird to get them back.",
  outside:
    "Only the workspace's agent, and what it starts, can use its tools. A Claude teammate in split-pane (tmux) mode runs under tmux, outside the pane, so it gets none of them: Mockingbird's tools work for in-process teammates. Mockingbird has logged this for the user.",
} as const;

/** Messages allowed between one pair of sessions per window, in either direction. */
const PAIR_LIMIT = 8;
const PAIR_WINDOW_MS = 5 * 60_000;
const MAX_MESSAGE = 8000;
/** send_message's answer for the Helpdesk tasks workspace: nothing another agent writes becomes its prompt. */
const HELPDESK_TAKES_NO_MESSAGES = "That session is the Helpdesk tasks workspace, which works in the user's own Chrome and does not take agent messages.";
/** How often a stream of requests with no valid token is logged. */
const NO_TOKEN_LOG_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The Mockingbird MCP server's name in the agents' configs. */
export const MCP_SERVER = "mockingbird";

/** Its tools: sessions get list/send; Collaborate's models get the room's two. */
export const MCP_TOOL = {
  listSessions: "list_sessions",
  sendMessage: "send_message",
  listLinks: "list_links",
  askCodeReader: "ask_code_reader",
  approvePermission: "approve_permission",
} as const;

/**
 * Every tool a pane or a Council seat has. A name the Assistant shares with one of these (list_sessions) is, for that
 * caller, its own tool; dispatch refuses it the Assistant's others.
 */
const CALLER_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(MCP_TOOL),
  ...[...WIRE_TOOL_SCHEMAS, ...TICKET_TOOL_SCHEMAS, ...HOUSE_TOOL_SCHEMAS, ...ARTIFACT_TOOL_SCHEMAS, ...TEAM_CHANGES_TOOL_SCHEMAS].map((t) => t.name),
]);

/** A Mockingbird tool as Claude Code names it (--allowedTools, --permission-prompt-tool). */
export const claudeToolName = (tool: string): string => `mcp__${MCP_SERVER}__${tool}`;

/** How a session's agent launches the Mockingbird MCP server. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// A stdio MCP server run by the app's own binary as plain Node
// (ELECTRON_RUN_AS_NODE), so it needs no Node install. It only relays tool
// calls to the app over the socket; the app decides everything. It is plain
// JS written to disk because a child process cannot read from inside app.asar
// reliably.
const SCRIPT = String.raw`// Mockingbird agent messaging — MCP server (stdio). Generated by the app; edits are overwritten.
const fs = require("fs");
const net = require("net");
const readline = require("readline");
const SOCK = process.env.MOCKINGBIRD_SOCK;
// Picks which tools are listed. It says nothing to the app about who's calling: only the token does.
const FROM = process.env.MOCKINGBIRD_SESSION;
// The app Assistant's turns: their tools are main's registry's, so tools/list asks the app for them.
const ASSISTANT = !!FROM && FROM.startsWith(${JSON.stringify(ASSISTANT_CALLER_PREFIX)});

// The token is read here, from a file Mockingbird keeps for as long as this server's launch runs: every server the
// agent starts from that launch (a sub-agent's, a reconnect) reads the same one. The file goes when the launch ends.
// Without a token, calls still reach Mockingbird with a code for why (lost) and the file it was given, so the user can
// be told when that's a launch still running; they get no answer. The words the user reads are Mockingbird's own.
const TOKEN_FILE = process.env.MOCKINGBIRD_TOKEN_FILE;
let lost = null;
function readToken(file) {
  if (!file) {
    lost = "nofile";
    return null;
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
    const token = fs.readFileSync(fd, "utf8").trim();
    if (!token) lost = "empty";
    return token || null;
  } catch (e) {
    lost = e.code === "ENOENT" ? "enoent" : "read:" + (/^[A-Z][A-Z0-9_]{0,23}$/.test(String(e.code)) ? e.code : "UNKNOWN");
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const TOKEN = readToken(TOKEN_FILE);
if (lost) process.stderr.write("mockingbird: no token (" + lost + "), so Mockingbird's tools won't answer\n");

// A Collaborate room's model gets the tools named in MOCKINGBIRD_TOOLS: asking
// the room's code reader, and (for Claude's --permission-prompt-tool, never the
// model itself) asking the user to allow a tool call.
const ROOM_TOOLS = [
  {
    name: ${JSON.stringify(MCP_TOOL.askCodeReader)},
    description:
      "You can't read this discussion's repository yourself; this asks the model in the council that can. " +
      "It searches and reads the code to answer your question, and its answer comes back here within your turn. " +
      "Ask a specific, self-contained question (what to look for, which part of the system), e.g. " +
      "\"How does the donor export build its query, and which file is it in?\" Each turn allows a few questions.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "What you need to know about the code" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: ${JSON.stringify(MCP_TOOL.approvePermission)},
    description: "Asks the user, in the Mockingbird council, to allow or deny a tool call. Called by Claude Code itself, not by the model.",
    inputSchema: {
      type: "object",
      properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
      required: ["tool_name", "input"],
    },
  },
];
const ROOM_TOOL_NAMES = (process.env.MOCKINGBIRD_TOOLS || ${JSON.stringify(MCP_TOOL.askCodeReader)}).split(",");

const SESSION_TOOLS = [
  {
    name: ${JSON.stringify(MCP_TOOL.listSessions)},
    description:
      "List the other coding-agent sessions open in Mockingbird (Claude and Codex panes the user is running), " +
      "with id, title, agent, repo, branch, group and status. same_group marks sessions working on the same ticket/group as you. " +
      "When your group is a shared team room, the sessions teammates run in it on their own laptops are listed too, " +
      "marked remote with their owner (their ids end in @ and the teammate's key); teammates lists who is connected. " +
      "A remote session with accepts_messages false (a terminal, an exited agent) is one its owner's Mockingbird won't type messages into; why says so. " +
      "Use it to find the session to coordinate with before ${MCP_TOOL.sendMessage}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: ${JSON.stringify(MCP_TOOL.sendMessage)},
    description:
      "Send a message to another Mockingbird session (by id from ${MCP_TOOL.listSessions}). It is typed into that session's prompt, " +
      "labelled as coming from you; if the session is busy it is delivered when its current turn ends. " +
      "Replies come back the same way, as a new prompt in your session — do not wait, sleep or poll for them. " +
      "Use it to coordinate work across repos, e.g. telling the frontend session about an API change you just made. " +
      "A remote session (on a teammate's laptop) gets it through the team room; the result says whether it was delivered, " +
      "queued, refused, or not sent because the teammate is offline. " +
      "Keep messages self-contained: the other session cannot see your conversation.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target session id, from ${MCP_TOOL.listSessions}" },
        message: { type: "string", description: "What to tell the other session" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: ${JSON.stringify(MCP_TOOL.listLinks)},
    description:
      "List the wires the user has drawn between this workspace and others in Mockingbird: direction, type (handoff, context, feedback, worktree), " +
      "the workspace at the other end and the wire's state. It lists only this workspace's wires. An empty list means it has none; " +
      "if some couldn't be read, incomplete says so.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  ...${JSON.stringify(WIRE_TOOL_SCHEMAS)},
  ...${JSON.stringify(TICKET_TOOL_SCHEMAS)},
  ...${JSON.stringify(HOUSE_TOOL_SCHEMAS)},
  ${ARTIFACT_TOOL_SCHEMAS.map((t) => JSON.stringify(t)).join(",\n  ")},
  ...${JSON.stringify(TEAM_CHANGES_TOOL_SCHEMAS)},
];

function ask(req) {
  return new Promise((resolve) => {
    if (!SOCK || !FROM) return resolve({ error: "This session was not started by Mockingbird, so it cannot message other sessions." });
    const c = net.createConnection(SOCK);
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({ error: "Mockingbird sent an unreadable reply." });
      }
    });
    c.on("error", (e) => resolve({ error: "Mockingbird is not reachable (" + (e.code || e.message) + ") — is the app running?" }));
    // claimed and tokenFile: the pane this server says it's for, and its launch's file, for telling the user when its
    // token isn't valid; never who's calling
    c.end(JSON.stringify({ ...req, token: TOKEN, claimed: FROM, tokenFile: TOKEN_FILE, ...(lost ? { lost } : {}) }));
  });
}

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notifications need no answer
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: ${JSON.stringify(MCP_SERVER)}, version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list": {
      if (!ASSISTANT) return ok({ tools: FROM && FROM.startsWith("collab-") ? ROOM_TOOLS.filter((t) => ROOM_TOOL_NAMES.includes(t.name)) : SESSION_TOOLS });
      const r = await ask({ op: ${JSON.stringify(ASSISTANT_LIST_OP)}, args: {} });
      const tools = r.result && Array.isArray(r.result.tools) ? r.result.tools : null;
      if (tools) return ok({ tools });
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: r.error || "Mockingbird didn't list the Assistant's tools." } });
    }
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const r = await ask({ op: name, args: (msg.params && msg.params.arguments) || {} });
      const text = r.error ? r.error : typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
      return ok({ content: [{ type: "text", text }], isError: !!r.error });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`;

/**
 * How an agent starts the Mockingbird MCP server; `tools` picks a room model's tools (sessions get theirs). Each call
 * makes a token that stands for `sessionId` until retireMcpLaunch: that goes with the launch, so whoever started the
 * launch calls it when the launch ends or fails. The env sits in the agent's argv, so it holds only the token's path.
 */
export function mcpLaunch(sessionId: string, tools?: string[]): McpLaunch {
  writeGenerated(MCP_SCRIPT, SCRIPT); // other agents' servers may be starting from it right now
  return {
    command: process.execPath,
    args: [MCP_SCRIPT],
    env: { ELECTRON_RUN_AS_NODE: "1", MOCKINGBIRD_SESSION: sessionId, MOCKINGBIRD_SOCK: SOCK, MOCKINGBIRD_TOKEN_FILE: tokens.mint(sessionId), ...(tools ? { MOCKINGBIRD_TOOLS: tools.join(",") } : {}) },
  };
}

/**
 * This launch now runs as process `pid` (a pane's pty, a Council turn's shell): its token works only from that process
 * or one it started. Called as soon as it's spawned, before it can have started a server; without it every call with
 * the token is refused.
 */
export function bindMcpLaunch(mcp: McpLaunch | undefined, pid: number | undefined): void {
  if (mcp && pid !== undefined) tokens.bind(mcp.env.MOCKINGBIRD_TOKEN_FILE, systemPeers.root(pid));
}

/** This launch is over: its token stops working, and its file goes. Safe to repeat. */
export function retireMcpLaunch(mcp: McpLaunch | undefined): void {
  if (mcp) tokens.retire(mcp.env.MOCKINGBIRD_TOKEN_FILE);
}

/** Quitting: no server starts from here on, so no launch's token file is left to outlive the run. */
export const removeMcpTokenFiles = (): void => tokens.removeAll();

export type Reply = { result: unknown } | { error: string };

/** Handles requests from Collaborate rooms' models (their tag is "collab-<room>.<seat>"). */
export type RoomRequestHandler = (roomId: string, seatKey: string, op: string, args: Record<string, unknown>) => Promise<Reply>;

// ---- teammates' sessions, through a team room ------------------------------------------------

export { remoteSessionId, parseRemoteId };

/** A room session as teammates see it. Sessions outside rooms are never shown to anyone. */
export interface RoomSessionInfo {
  id: string;
  title: string;
  agent: AgentKind;
  repo: string | null;
  branch: string | null;
  status: SessionStatus;
  waitingReason?: string | null;
  /** Why its owner's Mockingbird refuses agent messages to it (a terminal, an exited agent); absent when it takes them. */
  refused?: string;
}

/** One teammate's sessions in a room. */
export interface TeammateSessions {
  member: string;
  name: string;
  /** Answered just now. When false, `sessions` are as last seen (if ever) and `problem` says why. */
  connected: boolean;
  problem?: string;
  /** When `sessions` were read, ms. */
  at?: number;
  sessions: RoomSessionInfo[];
}

/** The sending session, as its own Mockingbird describes it. */
export interface SenderInfo {
  id: string;
  title: string;
  agent: AgentKind;
  repo: string | null;
  branch: string | null;
}

/** What became of a message to a teammate's session. `unconfirmed`: no answer came, so it may or may not have arrived. */
export type RemoteStatus = "delivered" | "queued" | "refused" | "offline" | "unconfirmed";

export interface RemoteSendResult {
  status: RemoteStatus;
  /** How it was delivered, or why it wasn't. */
  detail: string;
  toTitle?: string;
  /** The teammate who runs the session. */
  owner: string;
}

/**
 * The tool server of `session`'s running launch (by the token file main gave that launch) reached Mockingbird without a
 * usable token, and `why` is Mockingbird's own words for it. Never who's calling: only for telling the user.
 */
export interface ToolsLost {
  session: SessionInfo;
  why: string;
}

export interface MessagingHooks {
  /** main.log (logError), for what goes wrong here that no caller hears about. */
  log?: (context: string, err: unknown) => unknown;
  /** An agent's tool server has no valid token, logged already: the user is told once per pane launch. */
  onToolsLost?: (e: ToolsLost) => void;
  /** Who's at the other end of a connection; the system's (ps and lsof) unless a test says otherwise. */
  peers?: PeerCheck;
}

/** What the `list_links` tool answers from (src/main/wires.ts). */
export interface WireLinks {
  linksFor(me: SessionInfo): Reply;
  /**
   * Why `send_message` from `from` to `to` is off, or null: they're on either side of a team room's line (as a wire
   * would be), or a feedback wire joins them, so its rounds would go uncounted.
   */
  messageRefusal(from: SessionInfo, to: SessionInfo): string | null;
  /** Why `from` doesn't see `to` in list_sessions: they're on either side of a team room's line. Null when it does. */
  acrossRoomLine?(from: SessionInfo, to: SessionInfo): string | null;
}

/** What finish_step, read_context and read_terminal answer from (src/main/wireTools.ts), for the caller its token names. */
export interface WireToolCalls {
  call(me: SessionInfo, op: string, args: Record<string, unknown>): Promise<Reply>;
}

/** What set_stage, request_pr and write_patch_notes answer from (src/main/ticketTools.ts), on the ticket of the caller its token names. */
export interface TicketToolCalls {
  call(me: SessionInfo, op: string, args: Record<string, unknown>): Promise<Reply>;
}

/** The app Assistant's turns, the MCP caller its tokens name (src/main/assistant/service.ts). */
export interface AssistantCalls {
  /** tools/list for the turn caller `identity` is. */
  mcpList(identity: string): Reply;
  mcpCall(identity: string, op: string, args: Record<string, unknown>): Promise<Reply>;
  /** Whether `op` is one of the Assistant's tools, which every other caller is refused. */
  owns(op: string): boolean;
}

/** What a pane or a Council seat that asks for one of the Assistant's own tools is told. */
export const ASSISTANT_ONLY = "That tool is Mockingbird's Assistant's: only the Assistant can use it, never a workspace's agent.";

/** Teammates' room sessions, reached through the team room (src/main/team/agentBridge.ts). */
export interface RemoteAgents {
  /** The team room a local session is in, or null: only room sessions see and message teammates' sessions. */
  roomOf(session: SessionInfo): string | null;
  list(roomId: string): Promise<TeammateSessions[]>;
  send(roomId: string, from: SenderInfo, to: string, text: string): Promise<RemoteSendResult>;
}

/** A message from a teammate's session for one of this install's room sessions. */
export interface RemoteDelivery {
  /** The teammate whose session sent it. */
  member: { id: string; name: string };
  from: SenderInfo;
  /** A local session id. */
  to: string;
  text: string;
}

type Party = Pick<SessionInfo, "id" | "title" | "ticketTitle">;

const titleOf = (s: Party): string => s.ticketTitle ?? s.title;

export class Messaging {
  private pairs = new Map<string, number[]>();
  private roomHandler: RoomRequestHandler | null = null;
  private remote: RemoteAgents | null = null;
  private wires: WireLinks | null = null;
  private wireTools: WireToolCalls | null = null;
  private ticketTools: TicketToolCalls | null = null;
  private assistant: AssistantCalls | null = null;
  /**
   * When refusals were last logged: per running launch whose server lost its token, per pane for the rest that name one,
   * and once for all that name none. And the launches (by token file) whose loss the user has been told of.
   */
  private lostLogged = new Map<string, number>();
  private lostTold = new Set<string>();
  /** Launches whose callers the process check couldn't check, until it can again. */
  private checkFailing = new Set<string>();

  /** Collaborate registers here; until then room tools report that they're unavailable. */
  setRoomHandler(h: RoomRequestHandler): void {
    this.roomHandler = h;
  }

  /** The wire book registers here; until then `list_links` says it isn't ready, never "no links". */
  setWires(w: WireLinks): void {
    this.wires = w;
  }

  /** The wire tools register here; until then they say they aren't ready. */
  setWireTools(t: WireToolCalls): void {
    this.wireTools = t;
  }

  /** The ticket tools register here; until then they say they aren't ready. */
  setTicketTools(t: TicketToolCalls): void {
    this.ticketTools = t;
  }

  /** The app Assistant registers here; until then its turns' calls say it isn't ready. */
  setAssistant(a: AssistantCalls): void {
    this.assistant = a;
  }

  /** Team rooms register here; until then only this laptop's sessions are listed and reachable. */
  setRemote(r: RemoteAgents | null): void {
    this.remote = r;
  }

  constructor(
    private sessions: SessionManager,
    /** Whether a message to this session is submitted, or typed in and left for the user. */
    private submitOnDelivery: (target: SessionInfo) => boolean,
    /** Raised when two sessions hit the pair limit, so the user hears about a loop. */
    private onLoopLimit: (from: Party, to: Party) => void,
    /** Every send, delivered or refused, for the message log. */
    private onMessage: (m: AgentMessage) => void = () => {},
    private hooks: MessagingHooks = {}
  ) {
    // the tokens are the module's: whichever relay the app starts is where their problems are logged
    if (hooks.log) tokens.log = hooks.log;
  }

  private log(context: string, err: unknown): void {
    if (this.hooks.log) this.hooks.log(context, err);
    else console.warn(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }

  start(): void {
    tokens.sweep();
    // macOS caps socket paths at 104 bytes and silently truncates longer ones
    if (Buffer.byteLength(SOCK) > 100) {
      console.error(`messaging: socket path too long (${SOCK}) — agents cannot message each other`);
      return;
    }
    fs.mkdirSync(MB_DIR, { recursive: true });
    try {
      fs.unlinkSync(SOCK); // a previous run's socket — nothing is listening on it any more
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`messaging: cannot clear ${SOCK}:`, err);
    }
    const server = net.createServer({ allowHalfOpen: true }, (conn) => {
      let buf = "";
      conn.on("data", (d) => (buf += d));
      conn.on("end", async () => {
        let reply: Reply;
        let req: unknown;
        try {
          req = JSON.parse(buf);
        } catch {
          // JSON.parse's message quotes what it read, which may hold a token
          req = null;
        }
        try {
          reply = isObject(req) ? await this.dispatch(req, conn) : { error: "Bad request: not a JSON object." };
        } catch (err) {
          reply = { error: `Bad request: ${(err as Error).message}` };
        }
        if (!conn.destroyed) conn.end(JSON.stringify(reply));
      });
      conn.on("error", (err) => console.warn("messaging: connection error:", err.message));
    });
    server.on("error", (err) => console.error(`messaging: socket ${SOCK} failed — agents cannot message each other:`, err));
    server.listen(SOCK, () => {
      try {
        fs.chmodSync(SOCK, 0o600); // owner-only: any local process could otherwise type into sessions
      } catch (err) {
        console.error(`messaging: cannot restrict ${SOCK}; closing it:`, err);
        server.close();
      }
    });
  }

  private live(): SessionInfo[] {
    return this.sessions.list().filter((s) => s.status !== "dead" && !s.shell);
  }

  /**
   * Who's calling is the token's alone: anything a request says about its sender (`from`, or in its args) is ignored,
   * and a request without a token that's live gets no answer. The app Assistant's turns (assistant-<turn>) go to the
   * Assistant, and only there: none of their calls reaches a pane's tools. Room models (tagged collab-<room>.<seat>) go
   * to Collaborate; everything else is a session. Neither of those is let use the Assistant's own tools.
   */
  private async dispatch(req: Record<string, unknown>, conn: net.Socket): Promise<Reply> {
    const op = String(req.op ?? "");
    const args = isObject(req.args) ? req.args : {};
    const identity = tokens.identity(req.token);
    if (!identity) return this.noToken(op, req);
    const notCaller = await this.callerRefusal(op, identity, req, conn);
    if (notCaller) return notCaller;
    if (isAssistantCaller(identity)) {
      if (!this.assistant) return { error: "Mockingbird's Assistant isn't ready yet — try again in a moment." };
      return op === ASSISTANT_LIST_OP ? this.assistant.mcpList(identity) : this.assistant.mcpCall(identity, op, args);
    }
    if (!CALLER_TOOLS.has(op) && this.assistant?.owns(op)) return { error: ASSISTANT_ONLY };
    const m = /^collab-([^.]+)\.(.+)$/.exec(identity);
    if (!m) return this.handle({ op, from: identity, args });
    if (!this.roomHandler) return { error: "Council isn't ready yet — try again in a moment." };
    return this.roomHandler(m[1], m[2], op, args);
  }

  /**
   * Refused, saying why in Mockingbird's own words: a request brings only a code for that (`lost`). The user is told
   * once per launch, and only when the request names its pane's running launch by that launch's token file (`claimed`
   * and `tokenFile`): a server from a launch that has ended, or anything else on the socket, can't speak for a launch
   * that works or use up its one notice. Logged at most once a minute per running launch, per pane for the rest, and
   * once for all naming no pane, since whatever's asking may keep asking; what a request says goes in as plain text.
   * The token itself is never logged.
   */
  private noToken(op: string, req: Record<string, unknown>): Reply {
    const claimed = typeof req.claimed === "string" ? req.claimed : "";
    const session = claimed ? (this.sessions.list().find((s) => s.id === claimed && !s.shell) ?? null) : null;
    const file = typeof req.tokenFile === "string" && req.tokenFile ? req.tokenFile : null;
    const current = !!session && !!file && tokens.launchOf(file) === session.id;
    const why =
      req.lost !== undefined
        ? (lostReason(req.lost, current) ?? "it gave a reason this Mockingbird doesn't know")
        : req.token === undefined || req.token === null
          ? "it sent no token"
          : current
            ? "its token isn't the one its launch was given"
            : "its token is from a launch that has ended (its workspace was closed or restarted, or Mockingbird was)";
    const asked = `(asked for ${JSON.stringify(plainLine(op, 60))})`;
    const pane = session ? `${quoted(plainLine(titleOf(session)))} (${session.id})` : "";
    this.report(
      current ? `launch ${file}` : session ? `pane ${session.id}` : "none",
      () =>
        current
          ? `The tool server of ${pane} lost its Mockingbird tools: ${why} ${asked}`
          : session
            ? `A tool server naming ${pane}, not from its running launch, was refused: ${why} ${asked}`
            : claimed
              ? `A tool server naming ${quoted(plainLine(claimed, 80))}, which isn't an agent pane here, was refused: ${why} ${asked}`
              : `A tool server naming no pane was refused: ${why} ${asked}`,
      current && session ? { launch: file!, session, why } : undefined
    );
    return { error: noTokenText(why) };
  }

  /**
   * A live token, from a process that isn't its launch's or one of its descendants, or with no way to check: refused
   * (W20). Logged once a minute per launch and kind. The user is told once per launch only when the check couldn't run,
   * since that stops the pane's own calls; a process outside the pane holding its token isn't the pane's doing, and a
   * notice for it would be one more thing whoever holds the token could spend. Once the check works again, the log says
   * so and a later failure is told again. A launch that ended during the check is answered as ended.
   */
  private async callerRefusal(op: string, identity: string, req: Record<string, unknown>, conn: net.Socket): Promise<Reply | null> {
    const root = tokens.rootOf(req.token);
    const fd = (conn as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    const v = root
      ? await (this.hooks.peers ?? systemPeers).check(fd, root).catch((err: unknown) => {
          this.log("messaging: checking which process is calling", err);
          return { ok: false, failed: "the check itself failed" } as const;
        })
      : ({ ok: false, failed: "its launch has no process to check against" } as const);
    if (tokens.identity(req.token) !== identity || tokens.rootOf(req.token) !== root) return this.noToken(op, req);
    const launch = `${identity} ${root?.pid ?? "unbound"}`; // a launch's root pid is its own: each launch's pty is a new process
    if (v.ok) {
      if (this.checkFailing.delete(launch)) this.log("messaging", `Mockingbird can check who's calling with the token of ${identity} again, so its tools answer again`);
      this.lostTold.delete(`caller ${launch}`);
      return null;
    }
    const kind = "failed" in v ? "failed" : "gone" in v ? "gone" : "outside";
    if (kind === "failed") this.checkFailing.add(launch);
    const why =
      "failed" in v
        ? `Mockingbird couldn't check which process is calling (${v.failed})`
        : "gone" in v
          ? "its workspace's own process has ended"
          : "the process calling isn't one of its workspace's own";
    const session = this.sessions.list().find((s) => s.id === identity && !s.shell);
    const who = session ? `${quoted(plainLine(titleOf(session)))} (${session.id})` : identity;
    this.report(
      `caller ${kind} ${launch}`,
      () => `A call with the token of ${who} was refused: ${why} (asked for ${JSON.stringify(plainLine(op, 60))})`,
      "failed" in v && session ? { launch: `caller ${launch}`, session, why } : undefined
    );
    return { error: `Mockingbird refused this call: ${why}. ${CALLER_NEXT[kind]}` };
  }

  /** A refusal for the log, at most once a minute per `key`, and for the user once per `notice.launch`. */
  private report(key: string, line: () => string, notice?: { launch: string; session: SessionInfo; why: string }): void {
    const now = Date.now();
    if (now - (this.lostLogged.get(key) ?? -Infinity) >= NO_TOKEN_LOG_MS) {
      this.lostLogged.set(key, now);
      this.log("messaging", line());
    }
    if (notice && !this.lostTold.has(notice.launch)) {
      this.lostTold.add(notice.launch);
      try {
        this.hooks.onToolsLost?.({ session: notice.session, why: notice.why });
      } catch (err) {
        this.log("messaging: telling the user a pane lost its tools", err);
      }
    }
  }

  private async handle(req: { op?: string; from?: string; args?: Record<string, unknown> }): Promise<Reply> {
    const live = this.live();
    const me = live.find((s) => s.id === req.from);
    if (!me) return { error: "Your session is not known to Mockingbird (it may have been restarted)." };
    // what crosses the room's line for it: the room's tools, its wires and what they read, and its ticket's record
    const offLine = this.offRoomLine(me);
    const roomLine =
      isHouseTool(req.op) || req.op === ARTIFACT_TOOL.list || req.op === ARTIFACT_TOOL.read || isTeamChangesTool(req.op) || req.op === MCP_TOOL.listLinks || isWireTool(req.op) || isTicketTool(req.op);
    if (offLine && roomLine) return { error: offLine };

    // team rooms: the House board — it answers "not in a team room" for sessions outside one
    if (isHouseTool(req.op)) return houseToolCall(me.id, req.op!, req.args ?? {});
    // team rooms: artifacts — likewise, outside a room it says there are none
    if (req.op === ARTIFACT_TOOL.list || req.op === ARTIFACT_TOOL.read) return artifactToolCall(me, req.op, req.args ?? {});
    // team rooms: teammates' changes and migration numbers — likewise refused outside a room
    if (isTeamChangesTool(req.op)) return teamChangesToolCall(me, req.op!, req.args ?? {});
    if (req.op === MCP_TOOL.listLinks) return this.wires ? this.wires.linksFor(me) : { error: "Wires aren't ready yet — try again in a moment." };
    // wires: finishing a step and reading along a link, always as the token's session
    if (isWireTool(req.op)) return this.wireTools ? this.wireTools.call(me, req.op, req.args ?? {}) : { error: "Wires aren't ready yet — try again in a moment." };
    // tickets: moving its own ticket's stage, asking for a PR, writing patch notes, always on the token's session's ticket
    if (isTicketTool(req.op)) return this.ticketTools ? this.ticketTools.call(me, req.op, req.args ?? {}) : { error: "Ticket tools aren't ready yet — try again in a moment." };

    if (req.op === MCP_TOOL.listSessions) {
      // only this Mac's sessions on its side of a team room's line, which send_message reaches; what's left out isn't
      // counted or named, as the line names neither side. While the line can't be seen yet, none, saying so
      let starting: string | null = null;
      const others: Record<string, unknown>[] = live
        .filter((s) => {
          if (s.id === me.id || s.debrief || s.role === "tasks") return false;
          const across = this.wires?.acrossRoomLine?.(me, s) ?? null;
          if (across === ROOMS_STARTING) starting = across;
          return !across;
        })
        .map((s) => ({
          id: s.id,
          title: titleOf(s),
          agent: s.agent ?? "claude",
          repo: s.repoPath ? path.basename(s.repoPath) : null,
          branch: s.branch,
          group: s.taskGroup,
          status: s.status,
          same_group: !!me.taskGroup && !!s.taskGroup && topOfKey(me.taskGroup) === topOfKey(s.taskGroup),
        }));
      const result: Record<string, unknown> = { you: { id: me.id, title: titleOf(me) }, sessions: others };
      if (starting) result.note = starting;
      const roomId = this.remote?.roomOf(me) ?? null;
      if (offLine) result.teammates_error = offLine;
      else if (this.remote && roomId) {
        try {
          const teammates = await this.remote.list(roomId);
          const group = me.taskGroup ? topOfKey(me.taskGroup) : null;
          result.sessions = [
            ...others,
            ...teammates.flatMap((t) =>
              t.sessions.map((s) => ({
                id: remoteSessionId(s.id, t.member),
                title: s.title,
                agent: s.agent,
                repo: s.repo,
                branch: s.branch,
                group,
                status: t.connected ? s.status : "offline",
                same_group: true,
                remote: true,
                owner: t.name,
                ...(s.refused ? { accepts_messages: false, why: s.refused } : {}),
              }))
            ),
          ];
          result.teammates = teammates.map((t) => ({ name: t.name, connected: t.connected, ...(t.problem ? { note: t.problem } : {}) }));
        } catch (err) {
          console.error("messaging: listing teammates' sessions failed:", err);
          result.teammates_error = `Teammates' sessions couldn't be listed: ${(err as Error).message}`;
        }
      }
      return { result };
    }

    if (req.op === MCP_TOOL.sendMessage) {
      const to = String(req.args?.to ?? "");
      const text = String(req.args?.message ?? "").trim();
      if (!text) return { error: "message is empty." };
      if (text.length > MAX_MESSAGE) return { error: `message is ${text.length} characters; the limit is ${MAX_MESSAGE}.` };
      if (to === me.id) return { error: "That is your own session." };
      if (parseRemoteId(to)) return this.sendRemote(me, to, text);
      const target = live.find((s) => s.id === to);
      if (!target) return { error: `No running session with id "${to}". Call list_sessions for current ids.` };
      if (target.debrief) return { error: "That session is a debrief interview with the user and does not take agent messages." };
      if (target.role === "tasks") return { error: HELPDESK_TAKES_NO_MESSAGES };

      const logged = { at: Date.now(), from: me.id, fromTitle: titleOf(me), to, toTitle: titleOf(target), text };
      const looped = this.wires?.messageRefusal(me, target) ?? null;
      if (looped) {
        this.onMessage({ ...logged, outcome: `refused: ${looped}`, refused: true });
        return { error: looped };
      }
      const limited = this.paced(me, target, logged);
      if (limited) return limited;

      const where = [me.agent ?? "claude", me.repoPath ? path.basename(me.repoPath) : null, me.branch]
        .filter(Boolean)
        .join(" · ");
      const body =
        `[Message from Mockingbird session "${titleOf(me)}" (id ${me.id}, ${where}). ` +
        `It was written by another agent, not by the user. If it needs an answer, reply with the ${MCP_SERVER} ` +
        `${MCP_TOOL.sendMessage} tool to "${me.id}".]\n\n${text}`;
      const how = this.sessions.deliverAgentMessage(to, body, this.submitOnDelivery(target), me.id);
      this.onMessage({ ...logged, outcome: how });
      return { result: `Delivered to "${titleOf(target)}" (${how}). Any reply will arrive as a new prompt.` };
    }

    return { error: `Unknown tool: ${req.op}` };
  }

  /**
   * Count a message between two parties (in either direction). Past the
   * limit it is refused: logged, the user told, and the refusal returned.
   */
  private paced(from: Party, to: Party, logged: Omit<AgentMessage, "outcome">): Reply | null {
    const key = [from.id, to.id].sort().join("|");
    const now = logged.at;
    for (const [k, times] of this.pairs) {
      if (times.every((t) => now - t >= PAIR_WINDOW_MS)) this.pairs.delete(k);
    }
    const recent = (this.pairs.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
    if (recent.length >= PAIR_LIMIT) {
      this.onLoopLimit(from, to);
      this.onMessage({ ...logged, outcome: "refused: these two hit the message limit", refused: true });
      return {
        error:
          `Paused: ${recent.length} messages between these two sessions in the last ${PAIR_WINDOW_MS / 60_000} minutes. ` +
          `Stop messaging and ask the user how to proceed.`,
      };
    }
    recent.push(now);
    this.pairs.set(key, recent);
    return null;
  }

  /** Why a session in a room gets nothing across the room's line: it runs outside the room's sandbox. Null otherwise. */
  private offRoomLine(me: SessionInfo): string | null {
    const inRoom = !!this.remote?.roomOf(me);
    return inRoom && outsideRoomSandbox(me.shell ? null : (me.agent ?? "claude"), this.sessions.guardsOf(me.id)) ? ROOM_SANDBOX_REFUSAL : null;
  }

  /** A message for a session on a teammate's laptop: through the room this session is in, with the real outcome. */
  private async sendRemote(me: SessionInfo, to: string, text: string): Promise<Reply> {
    const roomId = this.remote?.roomOf(me) ?? null;
    if (!this.remote || !roomId) {
      return { error: `"${to}" is a session on a teammate's laptop. Only sessions in a shared team room can reach teammates' sessions, and this session's group isn't shared.` };
    }
    const offLine = this.offRoomLine(me);
    if (offLine) return { error: offLine };
    const logged = { at: Date.now(), from: me.id, fromTitle: titleOf(me), to, toTitle: to, text };
    const limited = this.paced(me, { id: to, title: to, ticketTitle: null }, logged);
    if (limited) return limited;
    let r: RemoteSendResult;
    try {
      r = await this.remote.send(roomId, { id: me.id, title: titleOf(me), agent: me.agent ?? "claude", repo: me.repoPath ? path.basename(me.repoPath) : null, branch: me.branch }, to, text);
    } catch (err) {
      console.error(`messaging: sending to ${to} failed:`, err);
      r = { status: "unconfirmed", detail: `sending failed: ${(err as Error).message}`, owner: "the teammate" };
    }
    const ok = r.status === "delivered" || r.status === "queued";
    this.onMessage({
      ...logged,
      toTitle: `${r.toTitle ?? to} (${r.owner})`,
      outcome: ok ? `${r.detail} · on ${r.owner}'s laptop` : `${r.status}: ${r.detail}`,
      ...(r.status === "refused" || r.status === "offline" ? { refused: true } : {}),
    });
    if (ok) return { result: `Delivered to "${r.toTitle ?? to}" on ${r.owner}'s laptop (${r.detail}). Any reply will arrive as a new prompt.` };
    if (r.status === "offline") return { error: `Not sent: ${r.detail}` };
    if (r.status === "unconfirmed") return { error: `Not confirmed: ${r.detail}` };
    return { error: `Refused by ${r.owner}'s Mockingbird: ${r.detail}` };
  }

  /** Refuse a message from a teammate's session, saying why, and log it here. */
  refuseRemote(m: RemoteDelivery, detail: string, toTitle?: string): { status: "refused"; detail: string; toTitle?: string } {
    const logged = { at: Date.now(), from: remoteSessionId(m.from.id, m.member.id), fromTitle: `${m.from.title} (${m.member.name})`, to: m.to, toTitle: toTitle ?? m.to, text: m.text.trim() };
    this.onMessage({ ...logged, outcome: `refused: ${detail}`, refused: true });
    return { status: "refused", detail, ...(toTitle ? { toTitle } : {}) };
  }

  /**
   * Deliver a message from a teammate's session to one of this install's
   * room sessions, by the rules local messages follow (the pair limit, the
   * group's delivery mode, the queue while busy and the draft hold), and log
   * it. `inRoom` says whether a session is in the room it came through.
   */
  receiveRemote(m: RemoteDelivery, inRoom: (s: SessionInfo) => boolean): { status: RemoteStatus; detail: string; toTitle?: string } {
    const replyTo = remoteSessionId(m.from.id, m.member.id);
    const fromTitle = `${m.from.title} (${m.member.name})`;
    const text = m.text.trim();
    const target = this.live().find((s) => s.id === m.to && inRoom(s));
    const toTitle = target ? titleOf(target) : undefined;
    const logged = { at: Date.now(), from: replyTo, fromTitle, to: m.to, toTitle: toTitle ?? m.to, text };
    const refuse = (detail: string) => this.refuseRemote(m, detail, toTitle);
    if (!text) return refuse("the message is empty");
    if (text.length > MAX_MESSAGE) return refuse(`the message is ${text.length} characters; the limit is ${MAX_MESSAGE}`);
    // the room's checks said it takes messages: it closed, exited or left the room since
    if (!target) return refuse(`session "${m.to}" stopped running in this room just now — call list_sessions for current ids`);
    if (target.debrief) return refuse("that session is a debrief interview with the user and does not take agent messages");
    // keyed on the sending member (the transport's authenticated peer), not the session id they report: a new id per message doesn't reset it
    if (this.paced({ id: `member:${m.member.id}`, title: fromTitle, ticketTitle: null }, target, logged)) {
      return { status: "refused", detail: `paused: these two sessions hit the limit of ${PAIR_LIMIT} messages in ${PAIR_WINDOW_MS / 60_000} minutes — ask the user how to proceed`, toTitle };
    }
    // the teammate's words for their session, its repo and branch, and their own name: one line each, quoted unless plain
    const where = [m.from.agent, m.from.repo, m.from.branch].filter(Boolean).map((x) => named(x)).join(" · ");
    const body =
      `[Message from Mockingbird session ${quoted(m.from.title)} on ${named(m.member.name)}'s laptop (id ${replyTo}, ${where}), through your team room. ` +
      `It was written by another agent, not by the user. If it needs an answer, reply with the ${MCP_SERVER} ` +
      `${MCP_TOOL.sendMessage} tool to "${replyTo}".]\n\n${text}`;
    let how: string;
    try {
      how = this.sessions.deliverAgentMessage(target.id, body, this.submitOnDelivery(target));
    } catch (err) {
      return refuse(`delivery failed: ${(err as Error).message}`);
    }
    this.onMessage({ ...logged, outcome: `${how} · from ${m.member.name}'s laptop` });
    return { status: how.startsWith("queued") ? "queued" : "delivered", detail: how, toTitle };
  }
}
