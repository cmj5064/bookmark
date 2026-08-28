const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_e, v) => cb(v)),
  onUpdateProgress:   (cb) => ipcRenderer.on('update-progress',   (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded',  ()     => cb()),
  installUpdate: () => ipcRenderer.send('install-update'),
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (json) => ipcRenderer.send('data:save', json),
  loadDefaultCsvs: () => ipcRenderer.invoke('csv:loadDefault'),
  pickCsvFiles: () => ipcRenderer.invoke('csv:pickFiles'),
  getNotionConfig: () => ipcRenderer.invoke('notion:getConfig'),
  saveNotionConfig: (cfg) => ipcRenderer.invoke('notion:saveConfig', cfg),
  testNotion: () => ipcRenderer.invoke('notion:test'),
  importNotion: () => ipcRenderer.invoke('notion:import'),
});
