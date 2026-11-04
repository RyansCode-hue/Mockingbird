import { createContext, useContext } from "react";

/**
 * Inside the landscape's world, which a CSS transform scales and moves, `position: fixed` is fixed to the world rather
 * than the window: a dialog or a popover drawn there would be scaled with it and cut to its box. The landscape
 * provides `true` around its world, and Modal and Popover then draw themselves in a portal on the document's body,
 * at the window's own scale. Everywhere else they stay where they're rendered.
 */
export const LiftOut = createContext(false);

export const useLiftOut = (): boolean => useContext(LiftOut);
