import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, csharp, css, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", py: "python", go: "go", rs: "rust", rb: "ruby", php: "php",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", cs: "csharp",
  css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
  sh: "bash", zsh: "bash", bash: "bash", sql: "sql",
};

/** The highlight.js language for a file, by its name; null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "bash";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? null;
}

/** Past this, highlighting costs more than it's worth: the text is shown plain. */
export const MAX_HIGHLIGHT_CHARS = 400_000;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Highlighted HTML, one string per line. The whole text is highlighted at once
 * — a comment or string spanning lines is colored on every line — then split,
 * closing the spans open at each line break and reopening them on the next.
 * highlight.js escapes the source, so the HTML holds no markup from the file.
 */
export function highlightLines(text: string, lang: string | null): string[] {
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) return text.split("\n").map(escapeHtml);
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  const lines: string[] = [];
  const open: string[] = []; // the opening tags in effect
  let cur = "";
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = tag.exec(html)); ) {
    cur += html.slice(last, m.index);
    last = tag.lastIndex;
    if (m[0] === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (m[0] === "</span>") {
      open.pop();
      cur += m[0];
    } else {
      open.push(m[0]);
      cur += m[0];
    }
  }
  lines.push(cur + html.slice(last));
  return lines;
}
