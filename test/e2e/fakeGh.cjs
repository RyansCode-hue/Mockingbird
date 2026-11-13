// Stands in for GitHub's `gh` in the user's shell, for the app tests: `fakeGh.cjs <gh's arguments>`, run by Electron as
// Node from a bash shim (fakeGithub.ts) that the test HOME's ~/.zshrc puts first on PATH. Nothing reaches GitHub. It
// answers what Mockingbird asks of gh about one repository ($HOME/fake-gh/config.json: { repo: "owner/name", bare }):
// - `pr list --head B --base T --state open --json …`: the open pull requests from B into T;
// - `pr create --head B --base T --title … --body-file -`: a pull request opened, its page printed, refused as gh's is
//   when B isn't on the origin (the bare repository the stand-in ssh pushes to);
// - `pr view <number | branch> [--repo owner/name] --json …`: one pull request, or "no pull requests found".
// Its pull requests are $HOME/fake-gh/state.json ({ next, prs }), which a test changes to merge one (fakeGithub.ts'
// mergePr). Every call is a JSON line in $HOME/fake-gh/calls.jsonl; anything else is refused, saying so.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(process.env.HOME, "fake-gh");
const { repo, bare } = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const stateFile = path.join(dir, "state.json");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const body = flag("--body-file") === "-" ? fs.readFileSync(0, "utf8") : undefined;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ at: Date.now(), args, cwd: process.cwd(), ...(body !== undefined ? { body } : {}) }) + "\n");

const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { next: 1, prs: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const refuse = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(1);
};
/** A pull request as gh's --json prints it, with only the fields asked for. */
const asJson = (pr) => {
  const all = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    baseRefName: pr.base,
    headRefName: pr.head,
    latestReviews: [],
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.mergedAt ?? null,
  };
  const fields = (flag("--json") ?? "").split(",").filter(Boolean);
  return Object.fromEntries(fields.map((f) => [f, all[f] ?? null]));
};
if (flag("--repo") !== undefined && flag("--repo") !== repo) refuse(`fake gh: it stands in for ${repo} only, not ${flag("--repo")}`);

const cmd = `${args[0]} ${args[1]}`;
if (cmd === "pr list") {
  const want = flag("--state") ?? "open";
  const found = state.prs.filter((p) => p.head === flag("--head") && (!flag("--base") || p.base === flag("--base")) && (want === "all" || p.state === want.toUpperCase()));
  process.stdout.write(JSON.stringify(found.slice(0, Number(flag("--limit") ?? 30)).map(asJson)) + "\n");
} else if (cmd === "pr create") {
  const head = flag("--head");
  const base = flag("--base");
  let sha;
  try {
    sha = execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${head}`], { encoding: "utf8" }).trim();
  } catch {
    refuse(`fake gh: ${head} isn't on ${repo}: push it first`);
  }
  if (state.prs.some((p) => p.head === head && p.base === base && p.state === "OPEN")) refuse(`a pull request for branch "${head}" into branch "${base}" already exists`);
  const number = state.next++;
  const url = `https://github.com/${repo}/pull/${number}`;
  state.prs.push({ number, url, head, base, title: flag("--title"), body: body ?? "", state: "OPEN", headSha: sha, createdAt: new Date().toISOString() });
  save();
  process.stdout.write(`${url}\n`);
} else if (cmd === "pr view") {
  const which = args[2];
  const pr = /^\d+$/.test(which)
    ? state.prs.find((p) => p.number === Number(which))
    : (state.prs.filter((p) => p.head === which && p.state === "OPEN").at(-1) ?? state.prs.filter((p) => p.head === which).at(-1));
  if (!pr) refuse(`no pull requests found for branch "${which}"`);
  process.stdout.write(JSON.stringify(asJson(pr)) + "\n");
} else {
  refuse(`fake gh: \`gh ${args.join(" ")}\` isn't stood in for`);
}
