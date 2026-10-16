import { useEffect, useState } from "react";
import { blockedReasons, cardFill, chipColors, fillRuleFor, isBareBlockedTag, parseColor, tagColor, type CardPalette } from "../shared/cardRules";
import type { AdoCardRules, AdoWorkItem } from "../shared/types";

/** How many tags a board card shows before "+N"; the rest are in its tooltip and the detail. */
export const CARD_TAGS = 3;

type RGB = CardPalette["ground"];

/** The current theme's card colours, read from the design tokens. */
interface Theme {
  card: CardPalette;
  blockedGround: RGB; // a blocked card's background: --fill-blocked over --bg-pane
}

function readTheme(): Theme | null {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n: string) => cs.getPropertyValue(n).trim();
  const ground = parseColor(tok("--bg-pane"));
  const texts = ["--text-1", "--text-3", "--text-4", "--teal-text"].map((n) => parseColor(tok(n)));
  const blockedGround = ground && parseColor(tok("--fill-blocked"), ground);
  if (!ground || !blockedGround || texts.some((t) => !t)) {
    console.warn("[mockingbird] couldn't read the theme's card colours; Azure DevOps card and tag colours aren't applied");
    return null;
  }
  return { card: { light: document.documentElement.dataset.theme === "light", ground, texts: texts as RGB[] }, blockedGround };
}

/** The theme's card colours, re-read when the theme flips. */
export function useCardTheme(): Theme | null {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** A card's look: blocked (the app's red), or filled by the board's first matching rule. */
export interface CardLook {
  blocked: string[]; // why it's blocked; empty when it isn't
  fill: { rule: string; background: string; edge: string } | null;
  ground: RGB | null; // what its tag chips sit on
}

export function cardLook(it: AdoWorkItem, rules: AdoCardRules | null, theme: Theme | null): CardLook {
  const blocked = blockedReasons(it, rules);
  if (blocked.length) return { blocked, fill: null, ground: theme?.blockedGround ?? null };
  const rule = rules ? fillRuleFor(it, rules) : null;
  if (!rule || !theme) return { blocked, fill: null, ground: theme?.card.ground ?? null };
  const f = cardFill(rule.background, theme.card);
  return { blocked, fill: { rule: rule.name, ...f }, ground: parseColor(f.background) };
}

/** A work item's tags as chips, in the board's tag colours; at most `max`, then "+N". */
export function TagChips({ tags, rules, ground, light, max }: { tags: string[]; rules: AdoCardRules | null; ground: RGB | null; light: boolean; max?: number }) {
  // a plain "blocked" tag is what the Blocked chip already says
  const shown = max == null ? tags : tags.filter((t) => !isBareBlockedTag(t));
  if (!shown.length) return null;
  const visible = max == null ? shown : shown.slice(0, max);
  const more = shown.length - visible.length;
  return (
    <div className="wi-tags" data-tip={max != null ? `Tags: ${tags.join(", ")}` : undefined}>
      {visible.map((t) => {
        const c = rules && ground ? tagColor(t, rules) : null;
        return (
          <span key={t} className="chip tag" style={c && ground ? chipColors(c, ground, light) : undefined}>
            {t}
          </span>
        );
      })}
      {more > 0 && <span className="chip tag more">+{more}</span>}
    </div>
  );
}
