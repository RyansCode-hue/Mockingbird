import React, { useMemo } from "react";
import { chatSegments, type ChatSegment } from "./chatText";
import { externalUrlAllowed } from "../../shared/links";
import { openLink } from "../uiUtil";

/**
 * Markdown as the Team tab shows it — a room note, a .md file, a chat
 * message: headings, paragraphs, lists, quotes, fenced code, rules and pipe
 * tables, with the chat's inline text (code, bold, emphasis, https links,
 * @mentions, #[artifact] references) plus [label](https://…) links.
 *
 * Teammates write it, so it's parsed into blocks and rendered as React
 * elements only — never as HTML. Raw HTML stays literal text, images
 * (`![](…)`) stay text (nothing remote is ever loaded), and a link other
 * than https stays text; an https link opens through the app's https-only
 * open path.
 */

export type MdBlock =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "list"; items: MdItem[] }
  | { t: "quote"; blocks: MdBlock[] }
  | { t: "code"; lang: string; text: string }
  | { t: "rule" }
  | { t: "table"; head: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] };

export interface MdItem {
  depth: number;
  /** As written: "•" for a bullet, "3." for a numbered item. */
  marker: string;
  text: string;
  /** A task item's box: checked, unchecked, or not a task. */
  task: boolean | null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** Quotes inside quotes this deep and beyond are shown as their text. */
const MAX_QUOTE_DEPTH = 6;

const blank = (l: string) => !l.trim();

/** A heading's text without its closing #s ("## Title ##"); by hand, as a regex for it backtracks on long lines. */
function headingText(s: string): string {
  const t = s.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  return end === t.length ? t : end === 0 ? "" : t[end - 1] === " " || t[end - 1] === "\t" ? t.slice(0, end).trimEnd() : t;
}
const indentOf = (s: string) => [...s].reduce((n, c) => n + (c === "\t" ? 4 : 1), 0);

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const tableAt = (lines: string[], i: number) => {
  if (!lines[i].includes("|") || i + 1 >= lines.length || !TABLE_SEP.test(lines[i + 1])) return false;
  return splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
};

/** Whether line `i` starts a block other than a paragraph (so it ends one). */
const startsBlock = (lines: string[], i: number) =>
  FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || tableAt(lines, i);

export function markdownBlocks(text: string, depth = 0): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1].length, text: headingText(heading[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push(depth < MAX_QUOTE_DEPTH ? { t: "quote", blocks: markdownBlocks(body.join("\n"), depth + 1) } : { t: "p", text: body.join("\n") });
      continue;
    }
    if (ITEM.test(line)) {
      const items: MdItem[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (m) {
          const task = /^\[([ xX])\][ \t]+/.exec(m[3]);
          items.push({
            depth: Math.min(6, Math.floor(indentOf(m[1]) / 2)),
            marker: /^\d/.test(m[2]) ? m[2] : "•",
            text: task ? m[3].slice(task[0].length) : m[3],
            task: task ? task[1] !== " " : null,
          });
          i++;
        } else if (!blank(lines[i]) && indentOf(/^[ \t]*/.exec(lines[i])![0]) >= 2 && items.length) {
          items[items.length - 1].text += `\n${lines[i++].trim()}`; // an item's next line
        } else if (blank(lines[i]) && i + 1 < lines.length && ITEM.test(lines[i + 1])) {
          i++; // a list with blank lines between its items
        } else break;
      }
      out.push({ t: "list", items });
      continue;
    }
    if (tableAt(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]).slice(0, head.length));
      out.push({ t: "table", head, align, rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i])) {
      const setext = SETEXT.exec(lines[i]);
      if (setext) {
        out.push({ t: "h", level: setext[1][0] === "=" ? 1 : 2, text: para.join(" ") });
        para.length = 0;
        i++;
        break;
      }
      if (startsBlock(lines, i)) break;
      para.push(lines[i++].trim());
    }
    if (para.length) out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

// ---- inline text ----

export type InlineSegment = ChatSegment | { t: "mdlink"; label: string; url: string };

// inline code first, so a link written inside `code` stays code; `#[name](artifact:…)` is the chat's reference, not a link
const MD_LINK = /(`[^`\n]+`)|(?<!#)(!?)\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/g;

/** Lines longer than this are shown as they are: the inline patterns backtrack on very long lines. */
const MAX_INLINE_LINE = 4000;

/** Markdown text as segments: the chat's inline text, plus [label](https://…) links; images and other links as text. */
export function inlineSegments(text: string, members: readonly { name: string }[] = [], selfName = ""): InlineSegment[] {
  const out: InlineSegment[] = [];
  const push = (seg: InlineSegment) => {
    const last = out[out.length - 1];
    if (seg.t === "text" && last?.t === "text") last.s += seg.s;
    else if (seg.t !== "text" || seg.s) out.push(seg);
  };
  text.split("\n").forEach((line, n) => {
    if (n) push({ t: "text", s: "\n" });
    if (line.length > MAX_INLINE_LINE) return push({ t: "text", s: line });
    let at = 0;
    for (const m of line.matchAll(MD_LINK)) {
      if (m[1] !== undefined) continue;
      chatSegments(line.slice(at, m.index), members, selfName).forEach(push);
      at = m.index! + m[0].length;
      if (m[2] === "!" || !externalUrlAllowed(m[4])) push({ t: "text", s: m[0] });
      else push({ t: "mdlink", label: m[3], url: m[4] });
    }
    chatSegments(line.slice(at), members, selfName).forEach(push);
  });
  return out;
}

/** What inline text needs from the view around it. */
export interface InlineContext {
  /** An artifact reference as the view shows it (a chip); without it, the reference reads as #name. */
  artifact?: (id: string, label: string, key: number) => React.ReactNode;
}

const openHref = (url: string) => (ev: React.MouseEvent) => {
  ev.preventDefault();
  void openLink(url);
};

export function renderSegment(s: InlineSegment, i: number, ctx: InlineContext = {}): React.ReactNode {
  switch (s.t) {
    case "text":
      return <React.Fragment key={i}>{s.s}</React.Fragment>;
    case "code":
      return <code key={i}>{s.s}</code>;
    case "block":
      return <pre key={i}>{s.s}</pre>;
    case "bold":
      return <strong key={i}>{s.s}</strong>;
    case "em":
      return <em key={i}>{s.s}</em>;
    case "link":
      return (
        <a key={i} href={s.s} onClick={openHref(s.s)}>
          {s.s}
        </a>
      );
    case "mdlink":
      return (
        <a key={i} href={s.url} title={s.url} onClick={openHref(s.url)}>
          {s.label}
        </a>
      );
    case "mention":
      return (
        <span key={i} className={`rc-mention ${s.me ? "me" : ""} ${s.assistant ? "assistant" : ""}`}>
          {s.s}
        </span>
      );
    case "artifact":
      return ctx.artifact ? ctx.artifact(s.id, s.name, i) : <React.Fragment key={i}>#{s.name}</React.Fragment>;
  }
}

function Inline({ text, ctx }: { text: string; ctx: InlineContext }) {
  const segs = useMemo(() => inlineSegments(text), [text]);
  return <>{segs.map((s, i) => renderSegment(s, i, ctx))}</>;
}

function Block({ b, ctx }: { b: MdBlock; ctx: InlineContext }) {
  switch (b.t) {
    case "h":
      return React.createElement(`h${b.level}`, { className: "md-h" }, <Inline text={b.text} ctx={ctx} />);
    case "p":
      return (
        <p>
          <Inline text={b.text} ctx={ctx} />
        </p>
      );
    case "list":
      return (
        <ul className="md-list">
          {b.items.map((it, i) => (
            <li key={i} style={{ paddingLeft: it.depth * 16 }}>
              <span className="md-mark">{it.task === null ? it.marker : it.task ? "☑" : "☐"}</span>
              <span className="md-li">
                <Inline text={it.text} ctx={ctx} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote>
          {b.blocks.map((q, i) => (
            <Block key={i} b={q} ctx={ctx} />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre className="md-code">
          <code>{b.text}</code>
        </pre>
      );
    case "rule":
      return <hr />;
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                    <Inline text={c} ctx={ctx} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {b.head.map((_, ci) => (
                    <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                      <Inline text={r[ci] ?? ""} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Markdown rendered as elements (see the top of this file). */
export function MarkdownView({ text, ctx = {}, className = "" }: { text: string; ctx?: InlineContext; className?: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => (
        <Block key={i} b={b} ctx={ctx} />
      ))}
    </div>
  );
}
