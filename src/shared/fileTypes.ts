import { baseName } from "./paths";

/**
 * What a file is written in, judged by its name: one table for everything that
 * treats files by type (the editor's language, the diff highlighter), so they
 * agree about every name.
 */
export type FileLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "xml"
  | "markdown"
  | "yaml"
  | "sql"
  | "csharp"
  | "java"
  | "kotlin"
  | "scala"
  | "go"
  | "shell"
  | "toml"
  | "rust"
  | "ruby"
  | "swift"
  | "php"
  | "properties"
  | "dockerfile"
  | "makefile";

const BY_EXT: Record<string, FileLanguage> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", vue: "html", razor: "html", cshtml: "html",
  xml: "xml", svg: "xml", csproj: "xml", props: "xml", targets: "xml", config: "xml", xaml: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", sql: "sql",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", go: "go",
  sh: "shell", bash: "shell", zsh: "shell", toml: "toml", rs: "rust", rb: "ruby", swift: "swift", php: "php",
  ini: "properties", env: "properties", properties: "properties", cfg: "properties",
};

/** The file's language by its name; null for plain text. */
export function fileLanguage(path: string): FileLanguage | null {
  const name = baseName(path).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === ".env" || name.startsWith(".env.")) return "properties";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? null;
}
