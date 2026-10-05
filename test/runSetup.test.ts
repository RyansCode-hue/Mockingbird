import { describe, expect, it } from "vitest";
import { draftForEditing } from "../src/renderer/runSetup";
import type { RunProfile } from "../src/shared/types";

describe("a drafted run setup, for the editor", () => {
  it("opens a draft that didn't validate with its JSON to fix by hand, and the reason", () => {
    const raw = JSON.stringify({ services: [{ name: "api" }] });
    const r = draftForEditing({ error: "services[0] has no command", raw });
    expect(r).not.toHaveProperty("error");
    expect(r).toEqual({ text: JSON.stringify({ services: [{ name: "api" }] }, null, 2), note: "The draft needs fixing before it can be saved: services[0] has no command" });
  });

  it("keeps a reply that isn't plain JSON as it came, rather than quoting it", () => {
    const raw = "```json\n{ \"services\": [] }\n```";
    expect(draftForEditing({ error: "The reply had no services", raw })).toMatchObject({ text: raw });
  });

  it("opens a valid draft without its repo path", () => {
    const profile = { repo: "/r", services: [{ name: "api", cwd: ".", command: "npm start" }] } as unknown as RunProfile;
    const r = draftForEditing({ profile, raw: "" });
    expect("text" in r && JSON.parse(r.text)).toEqual({ services: [{ name: "api", cwd: ".", command: "npm start" }] });
  });

  it("stays an error when drafting failed outright", () => {
    expect(draftForEditing({ error: "Claude Code isn't installed" })).toEqual({ error: "Claude Code isn't installed" });
  });
});
