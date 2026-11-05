import { useRef, type ReactNode } from "react";
import { formatTokens, stageLabel, totalTokens, type GroupMeter, type MessageMode, type TicketPipeline } from "../shared/types";
import type { AreaRepo } from "../shared/landscape";
import type { TeamRoomSummary } from "../shared/team/types";
import { baseName } from "../shared/paths";
import { GroupUsage, shareText, usageTitle } from "./GroupUsage";
import { StageChip } from "./TicketPipeline";
import { RoomChatChip } from "./team/RoomChat";
import { FollowButtons, type Follow } from "./team/RoomLive";
import { Select } from "./Menu";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { AskIcon, KanbanIcon, LockIcon, MoreIcon } from "./Icons";
import { messageModes } from "./workspaceActions";

/**
 * A group's bar: the grid's group bar over the panes, and on the landscape each area's header along its top edge
 * (design B, with O's room buttons). Both show the group's name, its ticket's stage (or Pipeline), its usage, its
 * team room's chat and board, Follow, and Ask for status, from the same props and handlers.
 */
export interface GroupBarProps {
  group: string;
  title: string;
  /** The group's ticket, when it's a work item's: its stage chip, or Pipeline before it has one. */
  ticket: { id: string; title: string } | null;
  pipeline: TicketPipeline | undefined;
  onPipeline: () => void;
  meter: GroupMeter | undefined;
  /** The team room the group is shared as. */
  room: TeamRoomSummary | undefined;
  /** Open the room's chat. */
  onChat: () => void;
  onBoard: (roomId: string) => void;
  follow: Follow;
  /** Ask every agent in the group for a short status report. */
  onAsk: () => void;
}

const MSG_OPTIONS = (defaultSend: boolean) => messageModes(defaultSend).map((m) => ({ value: m.value, label: `Agent messages: ${m.label}`, description: m.title }));

/** The grid's group bar, over the active group's panes. */
export function GroupBar(p: GroupBarProps & { statusNote: string; msgMode: MessageMode | undefined; msgDefaultSend: boolean; onMsgMode: (mode: MessageMode | "") => void; count: string }) {
  return (
    <div className="groupbar">
      <span className="gb-name">{p.title}</span>
      {p.ticket &&
        (p.pipeline ? (
          <StageChip p={p.pipeline} onClick={p.onPipeline} />
        ) : (
          <button className="gb-btn" data-tip="Ticket pipeline — track this ticket from coding to done" onClick={p.onPipeline}>
            Pipeline
          </button>
        ))}
      <GroupUsage g={p.meter} what={p.title} />
      {/* team rooms: team chat */}
      {p.room && (
        <>
          <RoomChatChip room={p.room} onOpen={p.onChat} />
          {/* team rooms: the House board */}
          <button className="gb-btn" data-tip="House board — the room's Radley House tickets and who has each" onClick={() => p.onBoard(p.room!.id)}>
            <KanbanIcon />
            <span className="gb-t">Board</span>
          </button>
        </>
      )}
      {/* team rooms: following, only in a room's group, its own members to follow (changing the grid stops it) */}
      {p.room && <FollowButtons follow={p.follow} />}
      <span style={{ marginLeft: "auto" }} />
      {p.statusNote && <span className="flbl-info">{p.statusNote}</span>}
      <Select
        className="gb-btn gb-msg"
        value={p.msgMode ?? ""}
        title="How messages from other agents arrive in this group's sessions: sent as a prompt, or typed in and left for you to send"
        onChange={(v) => p.onMsgMode(v as MessageMode | "")}
        options={MSG_OPTIONS(p.msgDefaultSend)}
      />
      <button className="gb-btn" data-tip="Ask every agent session in this group for a three-line status report — each answers when its current turn ends" onClick={p.onAsk}>
        <AskIcon />
        <span className="gb-t">Ask this group for status</span>
      </button>
      <span className="flbl-info gb-count">{p.count}</span>
    </div>
  );
}

/** A ticket's stage as an area shows it beside its name: "Build", or "#4182 · Build" when the name doesn't say the number. */
export const stageChip = (title: string, ticketId: string, p: TicketPipeline): string =>
  title.startsWith(`#${ticketId}`) ? stageLabel(p.stage) : `#${ticketId} · ${stageLabel(p.stage)}`;

/** A group's usage as B's header says it: "212k tokens · ≈9% of Claude's 5h", with the breakdown on hover. */
function AreaUsage({ g, what }: { g: GroupMeter | undefined; what: string }) {
  if (!g || totalTokens(g.tokens) === 0) return null;
  const share = shareText(g);
  return (
    <span className="ls-ah-usage" title={usageTitle(g, what)}>
      {formatTokens(totalTokens(g.tokens))} tokens{share ? ` · ${share}` : ""}
    </span>
  );
}

/**
 * An area's header on the landscape (design B, with O's room buttons): its name, repos, the ticket's stage or
 * Pipeline, what its sessions are doing, the room's Chat, Board and Members ▾, Follow, its usage, Ask for status, and
 * ⋯ (also on right-click) for everything else. A press on its bare part starts moving the area (`onGrab`).
 */
export function AreaHeader(
  p: GroupBarProps & {
    repos: readonly AreaRepo[];
    summary: string;
    locked: boolean;
    /** The room's Members ▾ (team/MembersMenu.tsx). */
    members: ReactNode;
    menu: () => MenuEntry[];
    /** Open the area's Artifacts window (the room's, or its own on this Mac). */
    onArtifacts?: () => void;
    onGrab?: (e: React.PointerEvent) => void;
  }
) {
  const ctx = useContextMenu(p.title);
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="ls-ah"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.openAt({ x: e.clientX, y: e.clientY }, p.menu());
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest("button, a, input, select, .ls-ah-usage")) return;
        p.onGrab?.(e);
      }}
    >
      <span className="ls-ah-name" title={p.title}>
        {p.title}
      </span>
      {p.locked && (
        <span className="ls-ah-lock" title="Locked: its layout stays as it is until it's unlocked">
          <LockIcon />
        </span>
      )}
      {p.repos.map((r) => (
        <span key={r.path} className="ls-ah-repo" title={`${r.path}${r.base ? ` · new worktrees start from ${r.base}` : ""}`}>
          {baseName(r.path)}
          {r.base ? ` · ${r.base}` : ""}
        </span>
      ))}
      {p.ticket &&
        (p.pipeline ? (
          <button type="button" className="ls-ah-stage" data-tip="Ticket pipeline — where this ticket is, and its next step" onClick={p.onPipeline}>
            {stageChip(p.title, p.ticket.id, p.pipeline)}
          </button>
        ) : (
          <button type="button" className="ls-ah-btn" data-tip="Ticket pipeline — track this ticket from coding to done" onClick={p.onPipeline}>
            Pipeline
          </button>
        ))}
      {p.summary && <span className="ls-ah-summary">{p.summary}</span>}
      {p.onArtifacts && (
        <button type="button" className="ls-ah-btn" data-tip={p.room ? "The room's artifacts: files, notes, repo files and links shared with it" : "The area's artifacts: files, notes, repo files and links kept on this Mac"} onClick={p.onArtifacts}>
          Artifacts
        </button>
      )}
      {p.room && (
        <>
          <RoomChatChip room={p.room} onOpen={p.onChat} area />
          <button type="button" className="ls-ah-btn" data-tip="House board — the room's Radley House tickets and who has each" onClick={() => p.onBoard(p.room!.id)}>
            Board
          </button>
          {p.members}
        </>
      )}
      {/* following, as the area's menu and bar have it: only in a room's area, its own members to follow */}
      {p.room && <FollowButtons follow={p.follow} />}
      <span className="ls-ah-gap" />
      <AreaUsage g={p.meter} what={p.title} />
      <button type="button" className="ls-ah-btn" data-tip="Ask every agent session here for a three-line status report — each answers when its current turn ends" onClick={p.onAsk}>
        Ask for status
      </button>
      <button type="button" ref={more} className="ls-ah-more" aria-label={`${p.title}: more`} data-tip="Rename, collapse, lock, agent messages… (or right-click)" onClick={() => more.current && ctx.openBelow(more.current, p.menu())}>
        <MoreIcon />
      </button>
      {ctx.menu}
    </div>
  );
}
