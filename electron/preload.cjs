const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onRelayStatus: (cb) => ipcRenderer.on('relay-status', (_, data) => cb(data)),
  saveRelayUrl: (url) => ipcRenderer.invoke('save-relay-url', url),
});
