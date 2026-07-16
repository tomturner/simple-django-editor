'use strict';
// Diagnostic: does a dynamically-created <webview> actually navigate/load with
// each method the app might use? Prints PASS/FAIL per scenario.

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

const MARKER = 'SDE_MARKER_OK';
let server, port, win;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>${MARKER} ${req.url}</body></html>`);
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

ipcMain.on('results', (_e, results) => {
  console.log('\n==== WEBVIEW NAV TEST RESULTS ====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${r.detail}`);
  console.log('==================================\n');
  if (server) server.close();
  app.exit(0);
});

app.whenReady().then(async () => {
  await startServer();
  win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));
  win.loadFile(path.join(__dirname, 'page.html'), { search: 'port=' + port });
  // Safety net if the page never reports back.
  setTimeout(() => { console.log('TIMEOUT: page did not report'); app.exit(2); }, 60000);
});
