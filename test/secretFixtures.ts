import * as fs from "fs";
import * as path from "path";
import { tempDir } from "./helpers";

/** Secret files as they turn up in repositories, at the top and deeper. */
export const SECRETS = [
  ".env",
  ".env.local",
  "api/.env.production",
  "config/dev.env",
  "certs/server.pem",
  "certs/server.key",
  "certs/client.pfx",
  "certs/client.p12",
  "credentials.json",
  "gcp/credentials.json",
  "secrets.json",
  "Functions/local.settings.json",
  "ado.pat",
  "tools/ado_pat.txt",
  "tools/azure-pat.txt",
  "pat.txt",
];

/** Files that look close but are ordinary work: a backup must carry them, a room session may read them. */
export const ORDINARY = ["src/env.ts", "src/keys.ts", "docs/compatibility.txt", "patterns.txt", "src/credentials.ts", "settings.json", "README.md"];

/** A WorkTracker folder whose config.json names `patFile` as the ADO PAT file. */
export function workTracker(patFile: string): string {
  const wt = tempDir("worktracker");
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "P", patFile } }));
  return wt;
}
