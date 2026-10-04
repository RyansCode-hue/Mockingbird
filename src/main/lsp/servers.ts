import * as fs from "fs";
import * as path from "path";
import { MB_DIR } from "../store";
import type { Pinned } from "../dap/adapters";
import type { LspServerId } from "../../shared/types";

/**
 * The language servers behind the editor's go-to-definition, hover,
 * completions, rename, problems and formatting. Each is downloaded on first
 * use at a pinned version and checked against its registry's SHA-512 before
 * it's unpacked:
 * - TypeScript and JavaScript: TypeScript 7's native compiler, whose
 *   `--lsp` mode is the language server (Apache-2.0).
 * - Python: pyright (MIT), run with Electron's own Node.
 * - C#: csharp-ls (MIT) on the Mac's .NET 10 runtime, using its SDK's MSBuild.
 */
export const LSP_DIR = path.join(MB_DIR, "lsp");

export interface LspServerSpec {
  id: LspServerId;
  label: string;
  /** File extension → the protocol's languageId. */
  languages: Record<string, string>;
  pinned: () => Pinned;
  /** What else it needs on the Mac, checked before it's offered. */
  requires?: { bin: string; why: string };
  command: (dir: string, bins: { node: string; dotnet: string | null }) => { cmd: string; args: string[]; env?: Record<string, string> };
}

const TS_NATIVE: Record<string, { pkg: string; integrity: string }> = {
  arm64: { pkg: "typescript-darwin-arm64", integrity: "sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==" },
  x64: { pkg: "typescript-darwin-x64", integrity: "sha512-SZ9xZInqApNlNGc9s0W1VSsktYSOe9cFqNOIqmN1Gs8SmkjKZYFt017G4VwPxASInODuAdbTW7sXiFUf893RgA==" },
};

export const SERVERS: LspServerSpec[] = [
  {
    id: "typescript",
    label: "TypeScript",
    languages: { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" },
    pinned: () => {
      const n = TS_NATIVE[process.arch];
      if (!n) throw new Error(`TypeScript's language server has no build for this Mac (${process.arch})`);
      return { name: "typescript", version: "7.0.2", url: `https://registry.npmjs.org/@typescript/${n.pkg}/-/${n.pkg}-7.0.2.tgz`, integrity: n.integrity, marker: "package/lib/tsc" };
    },
    command: (dir) => ({ cmd: path.join(dir, "package/lib/tsc"), args: ["--lsp", "--stdio"] }),
  },
  {
    id: "python",
    label: "Python",
    languages: { ".py": "python", ".pyi": "python" },
    pinned: () => ({
      name: "pyright",
      version: "1.1.414",
      url: "https://registry.npmjs.org/pyright/-/pyright-1.1.414.tgz",
      integrity: "sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==",
      marker: "package/langserver.index.js",
    }),
    command: (dir, bins) => ({ cmd: bins.node, args: [path.join(dir, "package/langserver.index.js"), "--stdio"], env: { ELECTRON_RUN_AS_NODE: "1" } }),
  },
  {
    id: "csharp",
    label: "C#",
    languages: { ".cs": "csharp" },
    requires: { bin: "dotnet", why: "C# needs the .NET SDK (dotnet) — the language server loads projects with its MSBuild" },
    pinned: () => ({
      name: "csharp-ls",
      version: "0.28.0",
      url: "https://api.nuget.org/v3-flatcontainer/csharp-ls/0.28.0/csharp-ls.0.28.0.nupkg",
      integrity: "sha512-oTi5yPnendY0PpsNDI9NUWN7un44YGt8Kwix2R6O76OfEhIwV/ZiX0JYErQ2HlKEG9KFZwTsEn/1AUTOBRcKmQ==",
      marker: "tools/net10.0/any/CSharpLanguageServer.dll",
    }),
    command: (dir, bins) => {
      if (!bins.dotnet) throw new Error("C# needs the .NET SDK (dotnet), and it isn't on this Mac's PATH");
      return { cmd: bins.dotnet, args: [path.join(dir, "tools/net10.0/any/CSharpLanguageServer.dll")] };
    },
  },
];

/** The server for a file, and the file's languageId; null when none covers it. */
export function serverFor(file: string): { spec: LspServerSpec; languageId: string } | null {
  const ext = path.extname(file).toLowerCase();
  for (const spec of SERVERS) if (spec.languages[ext]) return { spec, languageId: spec.languages[ext] };
  return null;
}

/** The project's own Python, so pyright resolves the packages it imports. */
export function projectPython(root: string): string | null {
  for (const v of [".venv", "venv", "env"]) {
    const p = path.join(root, v, "bin", "python");
    if (fs.existsSync(p)) return p;
  }
  return null;
}
