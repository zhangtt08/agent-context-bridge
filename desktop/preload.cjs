// 预加载：向页面安全暴露原生对话框与拖放路径解析（contextIsolation 下经 contextBridge）
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("acb", {
  pickFolder: () => ipcRenderer.invoke("acb:pick-folder"),
  pickArchive: () => ipcRenderer.invoke("acb:pick-archive"),
  // 拖放的 File 对象转本机真实路径（Electron ≥32 移除了 File.path，官方推荐 webUtils）
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
