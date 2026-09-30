// Electron 渲染图标 SVG → 多尺寸 PNG + ICO（隐藏窗口 + capturePage，带超时看门狗）
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "build");
const SIZES = [256, 128, 64, 48, 32, 16];

setTimeout(() => { console.error("WATCHDOG: timeout"); app.quit(); }, 15000).unref?.();

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const svg = fs.readFileSync(path.join(ROOT, "assets", "icon.svg"), "utf8");
    const win = new BrowserWindow({
      width: 256, height: 256, show: false, frame: false, useContentSize: true,
      webPreferences: { offscreen: false, paintWhenInitiallyHidden: true },
    });
    for (const size of SIZES) {
      const html = `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)}</body></html>`;
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      await new Promise((r) => setTimeout(r, 350));
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (!img || img.isEmpty()) { console.error("capture failed at", size); continue; }
      const png = img.toPNG();
      if (png.length < 100) { console.error("empty png at", size); continue; }
      fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
      console.log("saved icon-" + size + ".png bytes=" + png.length);
    }
    // ICO：多尺寸 PNG 内嵌
    const entries = SIZES.map((s) => ({ size: s, p: path.join(OUT, `icon-${s}.png`) })).filter((e) => fs.existsSync(e.p));
    if (entries.length) {
      const pngs = entries.map((e) => fs.readFileSync(e.p));
      const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
      const dir = Buffer.alloc(16 * entries.length);
      let offset = 6 + 16 * entries.length;
      entries.forEach((e, i) => {
        const o = i * 16;
        dir[o] = e.size >= 256 ? 0 : e.size; dir[o + 1] = e.size >= 256 ? 0 : e.size;
        dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
        dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
        offset += pngs[i].length;
      });
      fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([header, dir, ...pngs]));
      console.log("saved icon.ico entries=" + entries.length);
    }
  } catch (e) {
    console.error("render error:", e?.message ?? e);
  } finally {
    app.quit();
  }
});
