/**
 * An area's artifacts on this Mac (docs/landscape.md, Tools): an area that isn't a team room's keeps its files,
 * notes, repo file references and links here, by its key, with the room artifacts' records and store. The window
 * names the artifacts it shows by a shelf: a room's id for a room's (unchanged), `area:<key>` for an area's, so the
 * room artifacts' calls, viewer and shelf serve both. A room id is 22 base64url characters, never with a colon.
 */
export const AREA_SHELF = "area:";

/** The shelf of area `key`'s artifacts on this Mac. */
export const areaShelf = (key: string): string => `${AREA_SHELF}${key}`;

/** The area a shelf is of, or null for a room's. */
export const areaOfShelf = (shelf: string): string | null => (shelf.startsWith(AREA_SHELF) ? shelf.slice(AREA_SHELF.length) : null);

/** Who adds an area's artifacts: whoever uses this Mac. */
export const AREA_SELF = "you";
