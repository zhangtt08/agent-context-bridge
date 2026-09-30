// 预加载：向页面安全暴露原生的文件/目录选择对话框（contextIsolation 下经 contextBridge）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("acb", {
  pickFolder: () => ipcRenderer.invoke("acb:pick-folder"),
  pickArchive: () => ipcRenderer.invoke("acb:pick-archive"),
});
