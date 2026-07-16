'use strict';
// Loads the REAL renderer/index.html, clicks the ✦ Claude Code button, and
// verifies the embedded terminal drives a PTY whose output flows back.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win = null, ptyProc = null, acc = '', done = false;

function finish(pass, detail) {
  if (done) return;
  done = true;
  if (ptyProc) { try { ptyProc.kill(); } catch (e) {} }
  console.log('CC EMBED TEST: ' + (pass ? 'PASS' : 'FAIL') + '  ' + detail);
  app.exit(pass ? 0 : 1);
}

// Minimal stubs of the IPC the renderer calls during init.
ipcMain.handle('store:load', () => ({
  settings: { claudeCommands: [{ name: 'Echo', command: 'echo CC_EMBED_42; exit', isDefault: true }], view: { files: true, browser: true, terminal: true } },
  configs: [], lastConfigId: null
}));
ipcMain.handle('store:save', () => true);
ipcMain.handle('app:version', () => '0.0.0-test');

ipcMain.handle('cc:start', (_e, opts) => {
  opts = opts || {};
  let pty;
  try { pty = require('node-pty'); } catch (e) { finish(false, 'node-pty require failed: ' + e.message); return { ok: false }; }
  ptyProc = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l', '-i'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd: process.env.HOME, env: process.env });
  ptyProc.onData((d) => {
    acc += d;
    if (win && !win.isDestroyed()) win.webContents.send('cc:data', d);
    if (acc.indexOf('CC_EMBED_42') !== -1) finish(true, 'embedded terminal ran the command; output flowed back');
  });
  const cmd = (opts.command || '').trim();
  if (cmd) setTimeout(() => { if (ptyProc) ptyProc.write(cmd + '\r'); }, 400);
  return { ok: true, cwd: process.env.HOME };
});
ipcMain.on('cc:input', () => {});
ipcMain.on('cc:resize', () => {});
ipcMain.handle('cc:stop', () => true);

app.whenReady().then(() => {
  win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => { win.webContents.executeJavaScript("document.getElementById('btnClaudeCode').click(); true").catch((e) => finish(false, 'click failed: ' + e.message)); }, 600);
  });
  setTimeout(() => finish(false, 'timeout — no PTY output reached the embedded terminal'), 20000);
});
