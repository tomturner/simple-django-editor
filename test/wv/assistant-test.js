'use strict';
// Verifies the real renderer/assistant.html + preload load a live site into the
// assistant webview (uses example.com as a stand-in for claude.ai).

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

ipcMain.handle('assistant:list', () => ([{ name: 'Example', url: 'https://example.com', isDefault: true }]));
ipcMain.handle('update:open', () => true);

let done = false;
function finish(pass, detail) {
  if (done) return;
  done = true;
  console.log('ASSISTANT TEST: ' + (pass ? 'PASS' : 'FAIL') + '  ' + detail);
  app.exit(pass ? 0 : 1);
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('did-finish-load', () => {
    const u = contents.getURL();
    if (u && u.indexOf('example.com') !== -1) finish(true, 'assistant webview loaded ' + u);
  });
  contents.on('did-fail-load', (_e2, code, desc, url, isMain) => { if (isMain) console.log('guest fail ' + code + ' ' + url); });
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false, width: 500, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'assistant.html'));
  setTimeout(() => finish(false, 'timeout — assistant webview did not load'), 20000);
});
