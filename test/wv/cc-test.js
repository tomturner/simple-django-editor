'use strict';
// Verifies the real claudecode.html + preload drive a PTY: the renderer fetches
// commands, starts one, and its output flows back. Uses a benign echo command.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let ptyProc = null;
let win = null;
let acc = '';
let done = false;

function finish(pass, detail) {
  if (done) return;
  done = true;
  if (ptyProc) { try { ptyProc.kill(); } catch (e) {} }
  console.log('CC TEST: ' + (pass ? 'PASS' : 'FAIL') + '  ' + detail);
  app.exit(pass ? 0 : 1);
}

ipcMain.handle('cc:commands', () => ({
  commands: [{ name: 'Echo', command: 'echo CC_MARKER_$((6*7)); exit', isDefault: true }],
  cwd: process.env.HOME
}));
ipcMain.handle('cc:start', (_e, opts) => {
  opts = opts || {};
  let pty;
  try { pty = require('node-pty'); } catch (e) { finish(false, 'require node-pty failed: ' + e.message); return { ok: false }; }
  const shell = process.env.SHELL || '/bin/zsh';
  ptyProc = pty.spawn(shell, ['-l', '-i'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd: process.env.HOME, env: process.env });
  ptyProc.onData((d) => {
    acc += d;
    if (win && !win.isDestroyed()) win.webContents.send('cc:data', d);
    if (acc.indexOf('CC_MARKER_42') !== -1) finish(true, 'PTY command output reached back through the renderer flow');
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
    show: false, width: 900, height: 600,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'claudecode.html'));
  setTimeout(() => finish(false, 'timeout — no PTY output reached'), 20000);
});
