const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('scienceArena', Object.freeze({
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: value => ipcRenderer.invoke('settings:save', value),
  clearSettings: () => ipcRenderer.invoke('settings:clear'),
}));
