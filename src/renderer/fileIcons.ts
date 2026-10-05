import { baseName } from "../shared/paths";
/**
 * The explorer's file-type badges: a short label in the color of the language
 * family, from the theme's palette. Unknown types get no badge (a plain file icon).
 */
export interface FileBadge {
  label: string;
  /** A CSS color (a theme variable). */
  color: string;
}

const B = (label: string, color: string): FileBadge => ({ label, color });
const blue = "var(--m-3)";
const amber = "var(--amber)";
const olive = "var(--m-5)";
const violet = "var(--m-2)";
const peach = "var(--m-1)";
const pink = "var(--m-4)";
const mint = "var(--m-0)";
const red = "var(--red)";
const grey = "var(--text-3)";

const BY_EXT: Record<string, FileBadge> = {
  ts: B("TS", blue), tsx: B("TSX", blue), mts: B("TS", blue), cts: B("TS", blue),
  js: B("JS", amber), jsx: B("JSX", amber), mjs: B("JS", amber), cjs: B("JS", amber),
  py: B("PY", olive), ipynb: B("NB", olive),
  md: B("MD", violet), markdown: B("MD", violet), mdx: B("MDX", violet), txt: B("TXT", grey),
  json: B("{ }", peach), jsonc: B("{ }", peach), yml: B("YML", peach), yaml: B("YML", peach), toml: B("TML", peach), ini: B("INI", peach), env: B("ENV", peach),
  css: B("CSS", pink), scss: B("SCS", pink), less: B("LES", pink),
  html: B("<>", red), htm: B("<>", red), xml: B("<>", red), svg: B("SVG", pink), vue: B("VUE", mint),
  sh: B("SH", mint), zsh: B("SH", mint), bash: B("SH", mint), sql: B("SQL", mint),
  go: B("GO", blue), rs: B("RS", peach), rb: B("RB", red), php: B("PHP", violet),
  java: B("JV", amber), kt: B("KT", violet), kts: B("KT", violet), swift: B("SW", peach),
  cs: B("C#", violet), c: B("C", blue), h: B("H", blue), cpp: B("C++", blue),
  png: B("IMG", pink), jpg: B("IMG", pink), jpeg: B("IMG", pink), gif: B("IMG", pink), webp: B("IMG", pink), ico: B("IMG", pink),
  lock: B("LCK", grey), log: B("LOG", grey), csv: B("CSV", mint), pdf: B("PDF", red),
};

const BY_NAME: Record<string, FileBadge> = {
  dockerfile: B("DK", blue),
  makefile: B("MK", grey),
  ".gitignore": B("GIT", grey),
  ".gitattributes": B("GIT", grey),
  ".env": B("ENV", peach),
  "package.json": B("NPM", red),
  "package-lock.json": B("LCK", grey),
};

export function fileBadge(path: string): FileBadge | null {
  const name = baseName(path).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile.")) return BY_NAME.dockerfile;
  if (name.startsWith(".env.")) return BY_NAME[".env"];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXT[name.slice(dot + 1)] ?? null : null;
}
