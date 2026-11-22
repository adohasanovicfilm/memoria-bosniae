const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('mb', {
  load: () => ipcRenderer.invoke('mb:load'),
  save: (text) => ipcRenderer.invoke('mb:save', text),
  saveFile: (name, content) => ipcRenderer.invoke('mb:saveFile', name, content),
  poster: (f) => ipcRenderer.invoke('mb:poster', f),
  play: (url, title) => ipcRenderer.invoke('mb:play', url, title),
  openExternal: (url) => ipcRenderer.invoke('mb:openExternal', url),
  version: () => ipcRenderer.invoke('mb:version'),
  restart: () => ipcRenderer.invoke('mb:restart'),
  checkUpdate: () => ipcRenderer.invoke('mb:checkUpdate'),
  onUpdate: (cb) => ipcRenderer.on('mb:updateReady', (_e, v) => cb(v)),
  tokenInfo: () => ipcRenderer.invoke('mb:tokenInfo'),
  setToken: (t) => ipcRenderer.invoke('mb:setToken', t),
  publish: (json) => ipcRenderer.invoke('mb:publish', json),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } }
});
