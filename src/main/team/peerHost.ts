import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import * as path from "path";
import type { PeerHostBridge } from "./webrtc";
import type { HostCommand, HostEvent } from "../../shared/team/peerHost";

/**
 * The hidden window that holds Mockingbird's WebRTC connections (Electron's
 * Chromium; Node has none), bridged to the main process over IPC. It's never
 * shown, never throttled in the background, and restarted if its renderer
 * dies — the connections are then made again; room state lives in main.
 *
 * Its files are built next to the app's: peerhost.html, peerhost.js and
 * peerhost-preload.js (esbuild.mjs).
 */

const MAX_RESTARTS_PER_MINUTE = 5;

/**
 * Chromium switches for team connections; call before the app is ready.
 * Host candidates carry real local addresses instead of mDNS names, so two
 * laptops on a network that blocks multicast still connect directly; the
 * addresses only reach teammates and the team's own signaling Worker.
 */
export function configureWebRtc(app: Electron.App): void {
  app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
}

export class ElectronPeerHost implements PeerHostBridge {
  private win: BrowserWindow | null = null;
  private ready = false;
  private queue: HostCommand[] = [];
  private listener: (e: HostEvent) => void = () => undefined;
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private o: { assetsDir: string; log: (msg: string) => void }) {}

  /** The hidden window, so the app can tell it apart from its own. */
  get window(): BrowserWindow | null {
    return this.win;
  }

  setListener(cb: (e: HostEvent) => void): void {
    this.listener = cb;
  }

  start(): void {
    if (this.win || this.stopped || this.restartTimer) return;
    ipcMain.removeListener("peerhost:event", this.onIpc);
    ipcMain.on("peerhost:event", this.onIpc);
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      title: "Mockingbird peer host",
      webPreferences: {
        preload: path.join(this.o.assetsDir, "peerhost-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win = win;
    this.ready = false;
    if (process.platform === "darwin") win.excludedFromShownWindowsMenu = true;
    win.webContents.on("render-process-gone", (_e, details) => this.crashed(win, `its renderer ${details.reason} (exit ${details.exitCode})`));
    win.webContents.on("did-fail-load", (_e, code, desc) => this.crashed(win, `it didn't load (${code} ${desc})`));
    win.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") this.o.log(`peer host console: ${details.message}`);
    });
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.ready = false;
      }
    });
    win.loadFile(path.join(this.o.assetsDir, "peerhost.html")).catch((err) => this.crashed(win, `it didn't load: ${(err as Error).message}`));
  }

  command(cmd: HostCommand): void {
    if (this.ready && this.win && !this.win.isDestroyed()) this.win.webContents.send("peerhost:command", cmd);
    else this.queue.push(cmd);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    ipcMain.removeListener("peerhost:event", this.onIpc);
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** Simulate a crash (tests): the renderer is killed and the host restarts. */
  crashForTest(): void {
    this.win?.webContents.forcefullyCrashRenderer();
  }

  private onIpc = (e: IpcMainEvent, evt: HostEvent) => {
    if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) return; // only our own window speaks for the host
    if (evt?.ev === "ready") {
      this.ready = true;
      // commands from before a restart belong to connections that no longer exist
      const queued = this.queue.splice(0);
      this.listener(evt);
      for (const c of queued) if (c.op === "ice-servers") this.command(c);
      return;
    }
    this.listener(evt);
  };

  private crashed(win: BrowserWindow, why: string): void {
    if (this.win !== win || this.stopped) return;
    this.o.log(`peer host stopped: ${why}; restarting it`);
    this.win = null;
    this.ready = false;
    this.queue = [];
    if (!win.isDestroyed()) win.destroy();
    const now = Date.now();
    this.restarts = [...this.restarts.filter((t) => now - t < 60_000), now];
    if (this.restarts.length > MAX_RESTARTS_PER_MINUTE) {
      this.listener({ ev: "error", message: `the peer host keeps stopping (${why}); team connections are off until Mockingbird restarts` });
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 1000 * this.restarts.length);
  }
}
