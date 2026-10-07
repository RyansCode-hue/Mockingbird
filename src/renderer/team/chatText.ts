import { ASSISTANT_MENTION, knownHandle, mentionHandle } from "../../shared/team/chat";

/**
 * Chat text as the room shows it: light markdown — ```code blocks```,
 * `inline code`, **bold**, *emphasis* — plus https links (the only ones
 * the app opens) and @mentions. Parsed
 * into segments the view renders as elements, never as HTML.
 */
export type ChatSegment =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "block"; s: string }
  | { t: "bold"; s: string }
  | { t: "em"; s: string }
  | { t: "link"; s: string }
  | { t: "mention"; s: string; me: boolean; assistant: boolean };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(https:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(^|[^\w@])@([A-Za-z0-9][\w.-]*)/g;

export function chatSegments(text: string, members: readonly { name: string }[], selfName: string): ChatSegment[] {
  const out: ChatSegment[] = [];
  const push = (seg: ChatSegment) => {
    const last = out[out.length - 1];
    if (seg.t === "text" && last?.t === "text") last.s += seg.s;
    else if (seg.t !== "text" || seg.s) out.push(seg);
  };
  const selfKey = mentionHandle(selfName).toLowerCase();
  const inline = (part: string) => {
    let at = 0;
    for (const m of part.matchAll(INLINE)) {
      const start = m.index!;
      push({ t: "text", s: part.slice(at, start) });
      at = start + m[0].length;
      if (m[1] !== undefined) push({ t: "code", s: m[1] });
      else if (m[2] !== undefined) push({ t: "bold", s: m[2] });
      else if (m[3] !== undefined) push({ t: "em", s: m[3] });
      else if (m[4] !== undefined) push({ t: "link", s: m[4] });
      else {
        const handle = m[6].replace(/\.+$/, "");
        const trailing = m[6].slice(handle.length);
        push({ t: "text", s: m[5] });
        if (knownHandle(handle, members)) {
          const lower = handle.toLowerCase();
          push({ t: "mention", s: `@${handle}`, me: lower === selfKey || lower === selfName.toLowerCase().replace(/[^a-z0-9]/g, ""), assistant: lower === ASSISTANT_MENTION });
        } else push({ t: "text", s: `@${handle}` });
        push({ t: "text", s: trailing });
      }
    }
    push({ t: "text", s: part.slice(at) });
  };
  const fence = /```[^\n`]*\n?([\s\S]*?)(```|$)/g;
  let at = 0;
  for (const m of text.matchAll(fence)) {
    inline(text.slice(at, m.index));
    push({ t: "block", s: m[1].replace(/\n$/, "") });
    at = m.index! + m[0].length;
  }
  inline(text.slice(at));
  return out;
}
