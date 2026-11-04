import type { ArtifactRecord } from "../../shared/team/artifacts";
import type { RoomId } from "../../shared/team/types";

/**
 * Room artifacts handed to macOS (docs/team-rooms.md, "Artifacts"): Quick
 * Look (PDFs and other files the viewer doesn't show), Reveal in Finder and
 * Save as. Each acts, on an explicit click, on a path this process made — a
 * read-only, quarantined view copy, or the file the Save dialog chose (then
 * quarantined) — never a path from the window. Nothing is opened with its
 * default app: an artifact is never run.
 */

/** What the app's window offers (Electron's, in index.ts). */
export interface ViewerUi {
  /** Quick Look on the file (BrowserWindow.previewFile). */
  previewFile(path: string, displayName: string): void;
  showItemInFolder(path: string): void;
  /** The chosen path, or null when cancelled. */
  saveDialog(defaultName: string): Promise<string | null>;
  /** The chosen files, or null when cancelled. */
  openFilesDialog(): Promise<string[] | null>;
}

export interface ArtifactViewer {
  pickFiles(): Promise<string[] | null>;
  quickLook(roomId: RoomId, id: string): Promise<null>;
  reveal(roomId: RoomId, id: string): Promise<null>;
  saveAs(roomId: RoomId, id: string): Promise<{ path: string } | null>;
}

/** What the viewer needs of a shelf's artifacts: a room's (TeamArtifacts) or an area's on this Mac, by shelf (artifactShelves). */
export interface ViewedArtifacts {
  viewFile(shelf: string, id: string): Promise<string>;
  records(shelf: string): readonly ArtifactRecord[];
  saveName(shelf: string, id: string): string;
  exportTo(shelf: string, id: string, dest: string): Promise<string | null>;
}

export function artifactViewer(arts: ViewedArtifacts, ui: ViewerUi): ArtifactViewer {
  return {
    pickFiles: () => ui.openFilesDialog(),
    async quickLook(roomId, id) {
      const file = await arts.viewFile(roomId, id);
      ui.previewFile(file, arts.records(roomId).find((a) => a.id === id)?.name ?? "");
      return null;
    },
    async reveal(roomId, id) {
      ui.showItemInFolder(await arts.viewFile(roomId, id));
      return null;
    },
    async saveAs(roomId, id) {
      const dest = await ui.saveDialog(arts.saveName(roomId, id));
      if (!dest) return null;
      await arts.exportTo(roomId, id, dest);
      return { path: dest };
    },
  };
}
