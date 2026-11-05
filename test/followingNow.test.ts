import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MemberView } from "../src/shared/team/livePanes";
import { FollowButtons, FollowingNow, type Follow } from "../src/renderer/team/RoomLive";

// Where Following shows in the status bar, and how much of it gives way, is layout: test/uiStatusBar.test.ts measures it
// in Chrome. What it says, the parts the bar's shrink rules (styles.css) rely on, and that it's said once are here.
const nick = { member: "nick", name: "Nick Smith" } as unknown as MemberView;
const follow = (leader: Follow["leader"]): Follow => ({ leader, candidates: [nick], follow: () => {}, stop: () => {} });
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

describe("Following a teammate, said once in the status bar", () => {
  it("says whom, its words in a part of their own that can be cut, the whole on hover, and Stop beside them", () => {
    const out = html(createElement(FollowingNow, { follow: follow({ id: "nick", name: "Nick Smith", view: nick }) }));
    expect(out).toMatch(/^<span class="team-follow on" title="Following Nick\. Your grid mirrors what Nick Smith shows\. Changing your grid stops it\.">/);
    expect(out).toContain('<span class="tf-who">Following Nick</span><button class="gb-btn">Stop</button>');
  });
  it("says it's waiting while they show nothing shared", () => {
    const out = html(createElement(FollowingNow, { follow: follow({ id: "nick", name: "Nick Smith", view: undefined }) }));
    expect(out).toContain('<span class="tf-who">Following Nick — waiting for a shared session</span>');
    expect(out).toContain('title="Following Nick — waiting for a shared session. Your grid mirrors');
  });
  it("is nothing while no one is followed, and a room's bar offers Follow only then", () => {
    expect(html(createElement(FollowingNow, { follow: follow(null) }))).toBe("");
    expect(html(createElement(FollowButtons, { follow: follow(null) }))).toContain("Follow</span> Nick</button>");
    expect(html(createElement(FollowButtons, { follow: follow({ id: "nick", name: "Nick Smith", view: nick }) }))).toBe("");
  });
});
