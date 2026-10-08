import { describe, expect, it } from "vitest";
import { checkUpdateWith, repoFromPackage, type UpdateDeps } from "../src/main/updates";
import { isNewer } from "../src/shared/versions";

/** A fake GitHub: path → [status, body]; records whether calls carried a token. */
function github(routes: Record<string, [number, unknown]>) {
  const auth: (string | undefined)[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    auth.push((init?.headers as Record<string, string>)?.Authorization);
    const p = new URL(url).pathname.replace("/repos/me/app", "");
    const [status, body] = routes[p] ?? [404, { message: "Not Found" }];
    return new Response(JSON.stringify(body), { status, statusText: status === 404 ? "Not Found" : "OK" });
  }) as unknown as typeof fetch;
  return { f, auth };
}
const deps = (over: Partial<UpdateDeps>): UpdateDeps => ({ pkg: { repository: "github:me/app" }, current: "1.1.0", token: async () => "tok", fetch: github({}).f, ...over });
const pkgFile = (version: string) => ({ content: Buffer.from(JSON.stringify({ version })).toString("base64") });

describe("update source", () => {
  it("reads owner/repo from the forms package.json allows", () => {
    expect(repoFromPackage({ repository: "github:RyansCode-hue/Mockingbird" })).toEqual({ owner: "RyansCode-hue", repo: "Mockingbird" });
    expect(repoFromPackage({ repository: { url: "git+https://github.com/me/app.git" } })).toEqual({ owner: "me", repo: "app" });
    expect(repoFromPackage({})).toBeNull();
    // a dot in the name is part of it
    expect(repoFromPackage({ repository: "github:me/my.app" })).toEqual({ owner: "me", repo: "my.app" });
    expect(repoFromPackage({ repository: { url: "git+https://github.com/me/my.app.git" } })).toEqual({ owner: "me", repo: "my.app" });
    expect(repoFromPackage({ repository: "https://gitlab.com/me/app" })).toBeNull();
  });
  it("compares x.y.z versions", () => {
    expect(isNewer("1.1.0", "1.1.5")).toBe(true);
    expect(isNewer("1.1.5", "1.1.5")).toBe(false);
    expect(isNewer("1.10.0", "1.9.9")).toBe(false);
  });
});

describe("checking for an update", () => {
  it("uses the latest release when there is one, signed in with the GitHub CLI's token", async () => {
    const gh = github({ "/releases/latest": [200, { tag_name: "v1.2.0", html_url: "https://github.com/me/app/releases/v1.2.0" }] });
    expect(await checkUpdateWith(deps({ fetch: gh.f }))).toEqual({ current: "1.1.0", latest: "1.2.0", url: "https://github.com/me/app/releases/v1.2.0", newer: true, source: "release" });
    expect(gh.auth).toEqual(["Bearer tok"]);
  });
  it("falls back to the version on the default branch when nothing is released", async () => {
    const gh = github({ "/contents/package.json": [200, pkgFile("1.1.5")] });
    expect(await checkUpdateWith(deps({ fetch: gh.f }))).toMatchObject({ latest: "1.1.5", newer: true, source: "branch", url: "https://github.com/me/app" });
    expect(await checkUpdateWith(deps({ fetch: gh.f, current: "1.1.5" }))).toMatchObject({ newer: false });
  });
  it("explains a private repository instead of a bare 404", async () => {
    await expect(checkUpdateWith(deps({ token: async () => null }))).rejects.toThrow(/me\/app is private, and this Mac isn't signed in to GitHub.*gh auth login/);
    await expect(checkUpdateWith(deps({}))).rejects.toThrow(/the account the GitHub CLI is signed in to can't see me\/app/);
  });
  it("reports other GitHub failures as they are, and has nothing to check without a repository", async () => {
    const gh = github({ "/releases/latest": [500, {}] });
    await expect(checkUpdateWith(deps({ fetch: gh.f }))).rejects.toThrow(/GitHub answered 500/);
    expect(await checkUpdateWith(deps({ pkg: {} }))).toBeNull();
  });
});
