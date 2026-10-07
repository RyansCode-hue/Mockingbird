import { contextBridge, ipcRenderer } from "electron";

// The hidden peer host's only way out: commands from the main process in,
// connection events back. Nothing else of Electron or Node reaches the page.
contextBridge.exposeInMainWorld("peerHost", {
  onCommand: (cb: (cmd: unknown) => void) => {
    ipcRenderer.on("peerhost:command", (_e, cmd) => cb(cmd));
  },
  emit: (event: unknown) => ipcRenderer.send("peerhost:event", event),
});
