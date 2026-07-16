'use strict';
// Reproduces the real failure: server is (1) DOWN, then (2) UP but returns an
// EMPTY body during warmup, then (3) returns real content. The tab must end up
// showing the real content, not the empty warmup page.

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

const MARKER = 'SDE_REAL_CONTENT';
const PORT = 54330;
let server = null;
let phase = 'empty'; // 'empty' -> 'real'

ipcMain.on('result', (_e, r) => {
  console.log('\n==== WARMUP FLOW TEST ====');
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.detail}`);
  console.log('==========================\n');
  if (server) server.close();
  app.exit(r.pass ? 0 : 1);
});
ipcMain.on('log', (_e, m) => console.log('[page]', m));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, 'flow.html'), { search: 'port=' + PORT });

  // 1) DOWN for 2s, then bind. 2) empty body until 4s. 3) real content after.
  setTimeout(() => {
    server = http.createServer((req, res) => {
      if (phase === 'empty') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(''); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><html><head><title>Real</title></head><body><h1>${MARKER}</h1><p>${'x'.repeat(200)}</p></body></html>`); }
    });
    server.listen(PORT, '127.0.0.1', () => console.log('[main] bound on ' + PORT + ' (serving EMPTY warmup body)'));
  }, 2000);
  setTimeout(() => { phase = 'real'; console.log('[main] app warmed up — now serving REAL content'); }, 4000);

  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 30000);
});
