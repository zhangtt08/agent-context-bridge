// ACB 桌面壳（Electron）：进程内启动 API 服务，窗口加载同源页面
const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// 应用根目录：打包后 main.cjs 位于 resources/app/（server.cjs/dist 同级）；开发态位于 desktop/（上一级为仓库根）
const packed = fs.existsSync(path.join(__dirname, "server.cjs"));
const ROOT = packed ? __dirname : path.join(__dirname, "..");
process.chdir(ROOT);

let win = null;

async function createWindow() {
  let startServer;
  try {
    ({ startServer } = packed
      ? require(path.join(__dirname, "server.cjs"))
      : require(path.join(ROOT, "dist-server", "server", "index.js")));
  } catch (e) {
    dialog.showErrorBox("ACB 启动失败", String(e?.stack ?? e));
    app.quit();
    return;
  }
  const port = await startServer(Number(process.env.ACB_PORT) || 0); // 0=随机可用端口；测试/打包可注入固定端口

  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: "ACB — Agent Context Bridge",
    backgroundColor: "#efece5",
    // Windows 用 frame:false 自绘标题栏（三键内嵌页面）；macOS 保留系统红绿灯
    frame: process.platform === "darwin",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: fs.existsSync(path.join(__dirname, "preload.cjs"))
        ? path.join(__dirname, "preload.cjs")
        : undefined,
    },
  });
  Menu.setApplicationMenu(null);
  win.on("page-title-updated", (e) => e.preventDefault());
  // 最大化状态变化推给渲染层，驱动自绘标题栏的最大化/还原图标切换
  win.on("maximize", () => win?.webContents.send("acb:window-maximized", true));
  win.on("unmaximize", () => win?.webContents.send("acb:window-maximized", false));
  win.loadURL(`http://localhost:${port}/`);
}

ipcMain.handle("acb:pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择要注册的 Git 项目目录",
    properties: ["openDirectory"],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle("acb:pick-archive", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择 ACB 交接文件",
    properties: ["openFile"],
    filters: [{ name: "ACB 交接包", extensions: ["gz"] }, { name: "所有文件", extensions: ["*"] }],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

// 自绘标题栏的窗口三键（close 走系统关闭流程，与标题栏 X 行为一致）
ipcMain.handle("acb:window-minimize", () => win?.minimize());
ipcMain.handle("acb:window-toggle-maximize", () => {
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
});
ipcMain.handle("acb:window-close", () => win?.close());
ipcMain.handle("acb:window-is-maximized", () => !!win?.isMaximized());

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
