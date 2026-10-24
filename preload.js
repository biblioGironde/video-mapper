/* Pont minimal et sûr entre l'interface et le processus principal. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vmNative", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("vm:state"),
  openOutput: (displayId, fullscreen) => ipcRenderer.invoke("vm:open-output", displayId, fullscreen),
  closeOutput: () => ipcRenderer.invoke("vm:close-output"),
  toggleFullscreen: () => ipcRenderer.invoke("vm:toggle-fullscreen"),
  setAutoOpen: (on) => ipcRenderer.invoke("vm:set-auto-open", on),
  focusEditor: () => ipcRenderer.invoke("vm:focus-editor"),
  onOutputState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("output-state", h);
    return () => ipcRenderer.removeListener("output-state", h);
  },
  onMenu: (cb) => {
    const h = (_e, action) => cb(action);
    ipcRenderer.on("menu", h);
    return () => ipcRenderer.removeListener("menu", h);
  },
});
