import type { App, Shell } from "electron";
import { externalUrlAllowed } from "../shared/links";

// The app's windows show only the app's own pages, which run with its preload
// bridge. A page asking for another window, or to go to another page, is
// refused; an https link it names opens in the default browser instead.

export type Navigation = "stay" | "open-externally" | "refuse";

const withoutHash = (url: string) => url.replace(/#.*$/s, "");

/**
 * What to do with a page's request to show `url`: a navigation from the page
 * at `current`, or a new window (`current` null). Only the page itself (by
 * another hash, or reloaded) stays.
 */
export function navigationDecision(url: string, current: string | null): Navigation {
  if (current && withoutHash(url) === withoutHash(current)) return "stay";
  return externalUrlAllowed(url) ? "open-externally" : "refuse";
}

/** Apply navigationDecision to every web page the app creates, before any exists. */
export function guardNavigation(app: Pick<App, "on">, shell: Pick<Shell, "openExternal">, log: (msg: string) => void): void {
  const follow = (url: string, decision: Navigation) => {
    if (decision === "open-externally") shell.openExternal(url).catch((err: Error) => log(`opening ${url} in the browser failed: ${err.message}`));
    else if (decision === "refuse") log(`refused to open ${url.slice(0, 200)}: only https links open, and in the browser`);
  };
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      follow(url, navigationDecision(url, null));
      return { action: "deny" };
    });
    contents.on("will-navigate", (details) => {
      const decision = navigationDecision(details.url, contents.getURL());
      if (decision === "stay") return;
      details.preventDefault();
      follow(details.url, decision);
    });
  });
}
