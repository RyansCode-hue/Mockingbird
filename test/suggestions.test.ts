import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { LIST_TTL_MS, Suggestions, findGhOnPath, ghProblem } from "../src/main/suggestions";
import { composeSuggestion, draftProblem, suggestionStatus, suggestionText, type SuggestProblem } from "../src/shared/suggestions";

// gh is never the real one here: a fake gh script on a PATH of its own answers from files, and records every call.
// Nothing reaches GitHub, and no label or issue is created anywhere.
const FAKE_GH = `#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
for a in "$@"; do printf '%s\\037' "$a"; done >> "$D/calls.log"
echo >> "$D/calls.log"
answer() {
  local f="$D/answers/$1"
  [ -f "$f.out" ] && cat "$f.out"
  [ -f "$f.err" ] && cat "$f.err" >&2
  if [ -f "$f.code" ]; then exit "$(cat "$f.code")"; fi
  exit 0
}
case "$1 $2" in
  "auth status") answer auth ;;
  "api user") answer user ;;
  "repo view") answer repo ;;
  "label list") answer labels ;;
  "label create") answer "label-$3" ;;
  "issue create")
    cat > "$D/issue-body"
    for a in "$@"; do if [ "$a" = "--label" ] && [ -f "$D/answers/issue-labelled.code" ]; then answer issue-labelled; fi; done
    answer issue ;;
  "issue list") answer issues ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`;

type Answer = { out?: string; err?: string; code?: number };

function fakeGh(answers: Record<string, Answer> = {}) {
  const dir = tempDir("fake-gh");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(bin, "answers"), { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const answer = (name: string, a: Answer) => {
    for (const ext of ["out", "err", "code"] as const) fs.rmSync(path.join(bin, "answers", `${name}.${ext}`), { force: true });
    if (a.out !== undefined) fs.writeFileSync(path.join(bin, "answers", `${name}.out`), a.out);
    if (a.err !== undefined) fs.writeFileSync(path.join(bin, "answers", `${name}.err`), a.err);
    if (a.code !== undefined) fs.writeFileSync(path.join(bin, "answers", `${name}.code`), String(a.code));
  };
  const signedIn: Record<string, Answer> = {
    auth: { err: "github.com\n  ✓ Logged in to github.com account ryan (keyring)\n" },
    user: { out: "ryan\n" },
    repo: { out: JSON.stringify({ viewerPermission: "ADMIN", hasIssuesEnabled: true }) },
    labels: { out: JSON.stringify([{ name: "bug" }, { name: "suggestion" }]) },
    issue: { out: "https://github.com/RyansCode-hue/Mockingbird/issues/42\n" },
    issues: { out: "[]" },
  };
  for (const [k, v] of Object.entries({ ...signedIn, ...answers })) answer(k, v);
  const PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  return {
    PATH,
    answer,
    /** Every gh call so far, as its argument lists. */
    calls: (): string[][] =>
      fs.existsSync(path.join(bin, "calls.log"))
        ? fs.readFileSync(path.join(bin, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\x1f").slice(0, -1))
        : [],
    body: () => fs.readFileSync(path.join(bin, "issue-body"), "utf8"),
    service: (over: { canPost?: boolean; now?: () => number } = {}) =>
      new Suggestions({ findGh: async () => findGhOnPath(PATH), repo: () => ({ owner: "RyansCode-hue", repo: "Mockingbird" }), canPost: over.canPost ?? true, now: over.now }),
  };
}

const draft = composeSuggestion("  Show CI   status in the rail ", "A dot by the branch.\r\nGreen or red.", "1.4.10");
const problemOf = (r: unknown) => (r as SuggestProblem).problem;

describe("suggestions: what's posted", () => {
  it("posts the title on one line and the description with a footer naming the version", () => {
    expect(draft).toEqual({ title: "Show CI status in the rail", body: "A dot by the branch.\nGreen or red.\n\n---\nSuggested from Mockingbird 1.4.10." });
    expect(composeSuggestion("Title", "", "1.4.10").body).toBe("Suggested from Mockingbird 1.4.10.");
    expect(suggestionText(draft)).toBe(`${draft.title}\n\n${draft.body}`);
    expect(draftProblem(composeSuggestion("   ", "x", "1"))).toMatch(/title/);
    expect(draftProblem(composeSuggestion("x".repeat(200), "", "1"))).toMatch(/under 120/);
    expect(draftProblem(draft)).toBeNull();
  });

  it("reads an issue's status: open, on the roadmap, shipped, declined", () => {
    expect(suggestionStatus({ state: "OPEN", labels: [{ name: "suggestion" }] })).toBe("open");
    expect(suggestionStatus({ state: "OPEN", labels: [{ name: "suggestion" }, { name: "roadmap" }] })).toBe("roadmap");
    expect(suggestionStatus({ state: "OPEN", labels: [{ name: "roadmap" }, { name: "shipped" }] })).toBe("shipped");
    expect(suggestionStatus({ state: "CLOSED", stateReason: "COMPLETED" })).toBe("shipped");
    expect(suggestionStatus({ state: "CLOSED", stateReason: "" })).toBe("shipped");
    expect(suggestionStatus({ state: "CLOSED", stateReason: "NOT_PLANNED", labels: [{ name: "roadmap" }] })).toBe("declined");
    expect(suggestionStatus({ state: "CLOSED", stateReason: "DUPLICATE" })).toBe("declined");
  });

  it("finds gh on PATH, and only an executable file named gh", () => {
    const gh = fakeGh();
    expect(findGhOnPath(gh.PATH)).toMatch(/fake-gh.*\/bin\/gh$/);
    const empty = tempDir("no-gh");
    fs.writeFileSync(path.join(empty, "gh"), "not executable", { mode: 0o644 });
    expect(findGhOnPath(empty)).toBeNull();
    expect(findGhOnPath(undefined)).toBeNull();
  });
});

describe("suggestions through gh (a fake gh)", () => {
  it("checks sign-in, account and access, then files the issue with the suggestion label, the body on stdin", async () => {
    const gh = fakeGh();
    const s = gh.service();
    expect(await s.prepare()).toEqual({ repo: "RyansCode-hue/Mockingbird", login: "ryan", labels: "existing" });
    const posted = await s.post(draft);
    expect(posted).toEqual({ number: 42, url: "https://github.com/RyansCode-hue/Mockingbird/issues/42", labelled: true });
    const create = gh.calls().find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toEqual(["issue", "create", "--repo", "RyansCode-hue/Mockingbird", "--title", "Show CI status in the rail", "--body-file", "-", "--label", "suggestion"]);
    expect(gh.body()).toBe(draft.body);
    expect(gh.calls().some((c) => c[0] === "label" && c[1] === "create")).toBe(false);
  });

  it("passes a title with quotes and shell characters through untouched", async () => {
    const gh = fakeGh();
    const tricky = composeSuggestion(`Don't $(rm -rf ~) "quote" \`this\``, "", "1.4.10");
    await gh.service().post(tricky);
    expect(gh.calls().find((c) => c[1] === "create")?.[5]).toBe(tricky.title);
  });

  it("creates the three labels first only on the repository admin's install, when the repository has none yet", async () => {
    const gh = fakeGh({ labels: { out: JSON.stringify([{ name: "bug" }]) } });
    const s = gh.service();
    expect(await s.prepare()).toMatchObject({ labels: "create" });
    expect(await s.post(draft)).toMatchObject({ number: 42, labelled: true });
    const created = gh.calls().filter((c) => c[0] === "label" && c[1] === "create");
    expect(created.map((c) => c[2])).toEqual(["suggestion", "roadmap", "shipped"]);
    expect(created[0]).toEqual(["label", "create", "suggestion", "--repo", "RyansCode-hue/Mockingbird", "--color", "c5def5", "--description", expect.any(String)]);
  });

  it("files without a label, and says so, when the account can't set labels or the repository has none", async () => {
    const reader = fakeGh({ repo: { out: JSON.stringify({ viewerPermission: "READ", hasIssuesEnabled: true }) } });
    const posted = await reader.service().post(draft);
    expect(posted).toMatchObject({ number: 42, labelled: false, note: expect.stringMatching(/can't set labels.*without the suggestion label/) });
    expect(reader.calls().find((c) => c[1] === "create")).not.toContain("--label");
    expect(reader.calls().some((c) => c[0] === "label")).toBe(false);

    const writer = fakeGh({ repo: { out: JSON.stringify({ viewerPermission: "WRITE", hasIssuesEnabled: true }) }, labels: { out: "[]" } });
    expect(await writer.service().post(draft)).toMatchObject({ labelled: false, note: expect.stringMatching(/has no suggestion label yet/) });
    expect(writer.calls().some((c) => c[0] === "label" && c[1] === "create")).toBe(false);
  });

  it("files without the label when GitHub refuses it, and says so", async () => {
    const gh = fakeGh({ "issue-labelled": { err: "could not add label: 'suggestion' not found\n", code: 1 } });
    expect(await gh.service().post(draft)).toMatchObject({ number: 42, labelled: false, note: expect.stringMatching(/refused the suggestion label/) });
    expect(gh.calls().filter((c) => c[1] === "create")).toHaveLength(2);
  });

  it("says gh is missing, with the command that installs and signs it in", async () => {
    const s = new Suggestions({ findGh: async () => findGhOnPath(tempDir("empty-path")), repo: () => ({ owner: "o", repo: "r" }), canPost: true });
    for (const r of [await s.prepare(), await s.post(draft), await s.list()]) {
      expect(r).toEqual({ problem: "gh-missing", message: expect.stringMatching(/GitHub CLI \(gh\) isn't installed/), fix: "brew install gh && gh auth login" });
    }
  });

  it("says gh isn't signed in, with gh auth login, and files nothing", async () => {
    const gh = fakeGh({ auth: { err: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n", code: 1 } });
    const r = await gh.service().post(draft);
    expect(r).toEqual({ problem: "signed-out", message: expect.stringMatching(/isn't signed in/), fix: "gh auth login" });
    expect(gh.calls().some((c) => c[0] === "issue")).toBe(false);
  });

  it("says the account has no access to the repository", async () => {
    const gh = fakeGh({ repo: { err: "GraphQL: Could not resolve to a Repository with the name 'RyansCode-hue/Mockingbird'. (repository)\n", code: 1 } });
    const r = await gh.service().prepare();
    expect(problemOf(r)).toBe("no-access");
    expect((r as SuggestProblem).message).toMatch(/can't see RyansCode-hue\/Mockingbird/);
    expect(problemOf(await gh.service().post(draft))).toBe("no-access");
    expect(gh.calls().some((c) => c[0] === "issue")).toBe(false);
  });

  it("passes any other gh failure on as what gh said", async () => {
    const gh = fakeGh({ issue: { err: "HTTP 502: Server Error\n", code: 1 } });
    expect(await gh.service().post(draft)).toEqual({ problem: "failed", message: "gh: HTTP 502: Server Error" });
    expect(ghProblem({ code: 1, stdout: "", stderr: "" }, "o/r")).toEqual({ problem: "failed", message: "gh: exited with code 1" });
  });

  it("never files from a development build", async () => {
    const gh = fakeGh();
    expect(problemOf(await gh.service({ canPost: false }).post(draft))).toBe("dev-build");
    expect(gh.calls()).toEqual([]);
  });

  it("refuses an empty title before running gh", async () => {
    const gh = fakeGh();
    await expect(gh.service().post(composeSuggestion("", "", "1"))).rejects.toThrow(/title/);
    expect(gh.calls()).toEqual([]);
  });

  it("lists every suggestion with its status, the account's own marked, and reuses the list for a minute", async () => {
    const issues = [
      { number: 7, title: "Mine, planned", url: "u7", state: "OPEN", stateReason: "", labels: [{ name: "suggestion" }, { name: "roadmap" }], author: { login: "Ryan" }, createdAt: "2026-10-15T00:00:00Z" },
      { number: 5, title: "Nick's, shipped", url: "u5", state: "CLOSED", stateReason: "COMPLETED", labels: [{ name: "suggestion" }], author: { login: "nick" }, createdAt: "2026-10-14T00:00:00Z" },
      { number: 3, title: "Declined", url: "u3", state: "CLOSED", stateReason: "NOT_PLANNED", labels: [{ name: "suggestion" }], author: { login: "sam" }, createdAt: "2026-10-13T00:00:00Z" },
    ];
    const gh = fakeGh({ issues: { out: JSON.stringify(issues) } });
    let t = 1_000_000;
    const s = gh.service({ now: () => t });
    const list = await s.list();
    expect(list).toMatchObject({ repo: "RyansCode-hue/Mockingbird", login: "ryan", at: t });
    expect((list as { items: unknown[] }).items).toEqual([
      { number: 7, title: "Mine, planned", url: "u7", status: "roadmap", author: "Ryan", mine: true, createdAt: "2026-10-15T00:00:00Z" },
      { number: 5, title: "Nick's, shipped", url: "u5", status: "shipped", author: "nick", mine: false, createdAt: "2026-10-14T00:00:00Z" },
      { number: 3, title: "Declined", url: "u3", status: "declined", author: "sam", mine: false, createdAt: "2026-10-13T00:00:00Z" },
    ]);
    expect(gh.calls().find((c) => c[0] === "issue" && c[1] === "list")).toEqual([
      "issue", "list", "--repo", "RyansCode-hue/Mockingbird", "--label", "suggestion", "--state", "all", "--limit", "50", "--json", "number,title,url,state,stateReason,labels,author,createdAt",
    ]);
    const lists = () => gh.calls().filter((c) => c[1] === "list" && c[0] === "issue").length;
    await s.list();
    expect(lists()).toBe(1);
    t += LIST_TTL_MS + 1;
    await s.list();
    expect(lists()).toBe(2);
    await s.list(true);
    expect(lists()).toBe(3);
    // filing one forgets the list
    await s.post(draft);
    await s.list();
    expect(lists()).toBe(4);
  });

  it("doesn't keep a failed read: the next one asks gh again", async () => {
    const gh = fakeGh({ issues: { err: "HTTP 502\n", code: 1 } });
    const s = gh.service();
    expect(problemOf(await s.list())).toBe("failed");
    gh.answer("issues", { out: "[]" });
    expect(await s.list()).toMatchObject({ items: [] });
  });
});
