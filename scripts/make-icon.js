/**
 * Renders the app icon — the 🪶 feather on the design's dark dock tile
 * (design 1h: #242320 rounded tile) — to build/icon.png at 1024×1024.
 * Run via: npm run icon  (uses the local Electron to rasterize the emoji).
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.dock?.hide();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1100,
    webPreferences: { offscreen: true },
  });
  const html = `<canvas id="c" width="1024" height="1024"></canvas><script>
    const c = document.getElementById('c'), x = c.getContext('2d');
    function rr(x0, y0, w, h, r) {
      x.beginPath();
      x.moveTo(x0 + r, y0);
      x.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
      x.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
      x.arcTo(x0, y0 + h, x0, y0, r);
      x.arcTo(x0, y0, x0 + w, y0, r);
      x.closePath();
    }
    rr(64, 64, 896, 896, 200);
    x.fillStyle = '#242320';
    x.fill();
    x.font = '560px "Apple Color Emoji"';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('🪶', 512, 545);
  </script>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600)); // let the emoji font paint
  const dataUrl = await win.webContents.executeJavaScript(
    "document.getElementById('c').toDataURL('image/png')"
  );
  const out = path.join(__dirname, "..", "build");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "icon.png"), Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log("wrote build/icon.png");
  app.quit();
});
