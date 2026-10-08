import { describe, expect, it } from "vitest";
import { externalUrlAllowed } from "../src/shared/links";
import { guardNavigation, navigationDecision } from "../src/main/navigation";

const PAGE = "file:///Applications/Mockingbird.app/Contents/Resources/app.asar/dist/index.html";

describe("links leaving the app", () => {
  it("go to the browser only over https", () => {
    for (const url of ["https://github.com/acme/app/pull/7", "HTTPS://dev.azure.com/acme"]) expect(externalUrlAllowed(url), url).toBe(true);
    for (const url of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,<script>1</script>", "mailto:a@b.c", "x-apple.systempreferences:", "not a url", ""]) {
      expect(externalUrlAllowed(url), url).toBe(false);
    }
  });

  it("never open a window or another page in the app: https opens in the browser, anything else nowhere", () => {
    expect(navigationDecision("https://evil.example/login", null)).toBe("open-externally");
    expect(navigationDecision("file:///Users/me/.ssh/id_ed25519", null)).toBe("refuse");
    expect(navigationDecision(PAGE, null)).toBe("refuse"); // not even another copy of the app's own page
    expect(navigationDecision(`${PAGE}#settings`, PAGE)).toBe("stay");
    expect(navigationDecision(PAGE, `${PAGE}#settings`)).toBe("stay");
    expect(navigationDecision("https://evil.example/login", PAGE)).toBe("open-externally");
    expect(navigationDecision("http://evil.example/login", PAGE)).toBe("refuse");
    expect(navigationDecision("file:///tmp/other.html", PAGE)).toBe("refuse");
  });

  it("guards every page the app creates: new windows are denied, navigations away prevented, and refusals logged", async () => {
    let created: ((e: unknown, contents: unknown) => void) | undefined;
    const opened: string[] = [];
    const logs: string[] = [];
    guardNavigation({ on: ((event: string, cb: never) => event === "web-contents-created" && (created = cb)) as never }, { openExternal: async (url: string) => void opened.push(url) }, (m) => logs.push(m));

    let openHandler!: (d: { url: string }) => { action: string };
    let willNavigate!: (d: { url: string; preventDefault(): void }) => void;
    const contents = {
      getURL: () => PAGE,
      setWindowOpenHandler: (h: typeof openHandler) => (openHandler = h),
      on: (event: string, cb: typeof willNavigate) => event === "will-navigate" && (willNavigate = cb),
    };
    created!({}, contents);

    expect(openHandler({ url: "https://github.com/acme/app" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "file:///etc/hosts" })).toEqual({ action: "deny" });
    const nav = (url: string) => {
      let prevented = false;
      willNavigate({ url, preventDefault: () => (prevented = true) });
      return prevented;
    };
    expect(nav("https://dev.azure.com/acme")).toBe(true);
    expect(nav("javascript:alert(1)")).toBe(true);
    expect(nav(`${PAGE}#run`)).toBe(false);
    await Promise.resolve();
    expect(opened).toEqual(["https://github.com/acme/app", "https://dev.azure.com/acme"]);
    expect(logs).toEqual([expect.stringMatching(/^refused to open file:\/\/\/etc\/hosts/), expect.stringMatching(/^refused to open javascript:alert\(1\)/)]);
  });
});
