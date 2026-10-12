import { describe, expect, it } from "vitest";
import { terminalLines } from "../src/shared/terminalText";

describe("terminal output as plain lines", () => {
  it("keeps the spaces Claude Code writes as cursor moves, so its last words read as words", () => {
    // Claude Code 2.1.296 refusing `claude --resume` for a conversation held by a background session, as the pty got it
    const raw =
      "\x1b7\x1b[r\x1b8\x1b[?25hThat\x1b[6Gsession\x1b[14Gis\x1b[17Grunning\x1b[25Gin\x1b[28Gthe\x1b[32Gbackground.\x1b[44GRun\x1b[48G`claude\x1b[56Gagents`\x1b[64Gto\x1b[67Gfind\x1b[72Git\x1b[75Gand\r\r\n" +
      "open\x1b[6Git,\x1b[10Gor\x1b[13Gstop\x1b[18Git\x1b[21Gthere\x1b[27Gfirst\x1b[33Gto\x1b[36Gresume\x1b[43Git\x1b[46Ghere.\x1b[52GAdd\x1b[56G--fork-session\x1b[71Gto\x1b[74Gbranch\r\r\n" +
      "off\x1b[5Ga\x1b[7Gcopy\x1b[12Ginstead.\r\r\n\x1b[?25h\x1b(B\x0f\x1b[?1016l\x1b[?1006l\x1b[>4m\x1b[?2004l\x1b[<u\x1b[?25h\x1b7\x1b[r\x1b8\x1b[?25h";
    expect(terminalLines(raw).filter((l) => l)).toEqual([
      "That session is running in the background. Run `claude agents` to find it and",
      "open it, or stop it there first to resume it here. Add --fork-session to branch",
      "off a copy instead.",
    ]);
  });

  it("shows what a line ends up as: a carriage return writes over it, erasing ends it", () => {
    expect(terminalLines("downloading 10%\rdownloading 100%\r\n")).toEqual(["downloading 100%", ""]);
    expect(terminalLines("abcdef\r\x1b[3C\x1b[K\n")).toEqual(["abc", ""]);
    expect(terminalLines("ab\x1b[2Dz\tc")).toEqual(["zb      c"]);
  });

  it("drops colours, titles and modes", () => {
    expect(terminalLines("\x1b]0;my title\x07\x1b[1;32mok\x1b[0m \x1b[?1049hdone")).toEqual(["ok done"]);
  });
});
