/** Small helpers the App's views share. */
import { isErr } from "../shared/types";

/** Open a link in the browser; a refused or failed open is shown, never dropped. */
export async function openLink(url: string): Promise<void> {
  const r = await window.mb.openExternal(url);
  if (isErr(r)) alert(`Couldn't open ${url}: ${r.error}`);
}
