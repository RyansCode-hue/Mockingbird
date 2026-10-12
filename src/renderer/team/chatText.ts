import { ASSISTANT_MENTION, knownHandle, mentionHandle } from "../../shared/team/chat";
import { ARTIFACT_REF_RE } from "../../shared/team/artifacts";

/**
 * Chat text as the room shows it: light markdown — ```code blocks```,
 * `inline code`, **bold**, *emphasis* — plus https links (the only ones
 * the app opens), @mentions and room artifacts named as
 * #[name](artifact:id). Parsed into segments the view renders as elements,
 * never as HTML; nothing inside code is parsed.
 */
export type ChatSegment =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "block"; s: string }
  | { t: "bold"; s: string }
  | { t: "em"; s: string }
  | { t: "link"; s: string }
  | { t: "mention"; s: string; me: boolean; assistant: boolean }
  /** `name` is the label the message was written with; the view shows the artifact's current name. */
  | { t: "artifact"; id: string; name: string };

// the leftmost match wins: a reference inside `code` is part of the code, and a reference's
// name is only its label (never read as emphasis, a link or a mention)
const INLINE = new RegExp(
  [
    String.raw`\`([^\`\n]+)\``,
    ARTIFACT_REF_RE.source,
    String.raw`\*\*([^*\n]+)\*\*`,
    String.raw`(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])`,
    String.raw`(https:\/\/[^\s<>()]*[^\s<>().,;:!?'"])`,
    String.raw`(^|[^\w@])@([A-Za-z0-9][\w.-]*)`,
  ].join("|"),
  "g"
);

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
      else if (m[3] !== undefined) push({ t: "artifact", id: m[3], name: m[2] });
      else if (m[4] !== undefined) push({ t: "bold", s: m[4] });
      else if (m[5] !== undefined) push({ t: "em", s: m[5] });
      else if (m[6] !== undefined) push({ t: "link", s: m[6] });
      else {
        const handle = m[8].replace(/\.+$/, "");
        const trailing = m[8].slice(handle.length);
        push({ t: "text", s: m[7] });
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
