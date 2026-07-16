'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  openCompose: () => ipcRenderer.invoke('dialog:openCompose'),
  parseCompose: (filePath) => ipcRenderer.invoke('compose:parse', filePath),
  runStart: (payload) => ipcRenderer.invoke('run:start', payload),
  runStop: () => ipcRenderer.invoke('run:stop'),
  termInput: (data) => ipcRenderer.send('term:input', data),

  pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
  readdir: (p) => ipcRenderer.invoke('fs:readdir', p),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', { filePath: p, content }),
  searchProject: (root, query, caseSensitive) => ipcRenderer.invoke('project:search', { root, query, caseSensitive }),

  openClaudeCode: (projectRoot) => ipcRenderer.invoke('cc:openWindow', projectRoot),
  ccCommands: () => ipcRenderer.invoke('cc:commands'),
  ccStart: (opts) => ipcRenderer.invoke('cc:start', opts),
  ccStop: () => ipcRenderer.invoke('cc:stop'),
  ccInput: (data) => ipcRenderer.send('cc:input', data),
  ccResize: (size) => ipcRenderer.send('cc:resize', size),
  onCcData: (cb) => ipcRenderer.on('cc:data', (_e, d) => cb(d)),
  onCcExit: (cb) => ipcRenderer.on('cc:exit', (_e, i) => cb(i)),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openDownload: (url) => ipcRenderer.invoke('update:open', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, info) => cb(info)),

  onRunData: (cb) => ipcRenderer.on('run:data', (_e, data) => cb(data)),
  onRunInfo: (cb) => ipcRenderer.on('run:info', (_e, info) => cb(info)),
  onRunExit: (cb) => ipcRenderer.on('run:exit', (_e, info) => cb(info))
});
