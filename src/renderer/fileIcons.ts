import { baseName } from "../shared/paths";
import { extensionOf, fileLanguage, isEnvFile, type FileLanguage } from "../shared/fileTypes";

/**
 * The explorer's file-type badges: a short label in the color of the language
 * family, from the theme's palette. A file's language comes from fileTypes, so
 * the badge agrees with the editor and the diff highlighter; unknown types get
 * no badge (a plain file icon).
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

const BY_LANGUAGE: Partial<Record<FileLanguage, FileBadge>> = {
  typescript: B("TS", blue), tsx: B("TSX", blue), javascript: B("JS", amber), jsx: B("JSX", amber),
  python: B("PY", olive), markdown: B("MD", violet),
  json: B("{ }", peach), yaml: B("YML", peach), toml: B("TML", peach), properties: B("INI", peach),
  css: B("CSS", pink), scss: B("SCS", pink), less: B("LES", pink),
  html: B("<>", red), xml: B("<>", red),
  shell: B("SH", mint), sql: B("SQL", mint),
  go: B("GO", blue), rust: B("RS", peach), ruby: B("RB", red), php: B("PHP", violet),
  java: B("JV", amber), kotlin: B("KT", violet), swift: B("SW", peach), csharp: B("C#", violet),
  dockerfile: B("DK", blue), makefile: B("MK", grey),
};

/** Extensions whose badge says more than their language, and file types that aren't a language. */
const BY_EXT: Record<string, FileBadge> = {
  mdx: B("MDX", violet), svg: B("SVG", pink), vue: B("VUE", mint), env: B("ENV", peach),
  ipynb: B("NB", olive), txt: B("TXT", grey),
  c: B("C", blue), h: B("H", blue), cpp: B("C++", blue),
  png: B("IMG", pink), jpg: B("IMG", pink), jpeg: B("IMG", pink), gif: B("IMG", pink), webp: B("IMG", pink), ico: B("IMG", pink),
  lock: B("LCK", grey), log: B("LOG", grey), csv: B("CSV", mint), pdf: B("PDF", red),
};

const BY_NAME: Record<string, FileBadge> = {
  ".gitignore": B("GIT", grey),
  ".gitattributes": B("GIT", grey),
  "package.json": B("NPM", red),
  "package-lock.json": B("LCK", grey),
};

export function fileBadge(path: string): FileBadge | null {
  const byName = BY_NAME[baseName(path).toLowerCase()];
  if (byName) return byName;
  if (isEnvFile(path)) return BY_EXT.env;
  const lang = fileLanguage(path);
  return BY_EXT[extensionOf(path)] ?? (lang ? BY_LANGUAGE[lang] ?? null : null);
}
