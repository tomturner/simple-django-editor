'use strict';
// Requires the node-pty from the PACKAGED app (dist/) and spawns a shell,
// verifying the afterPack spawn-helper fix (no posix_spawnp failure).

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function findApp(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) return path.join(dir, e.name);
      const r = findApp(path.join(dir, e.name));
      if (r) return r;
    }
  }
  return null;
}

app.whenReady().then(() => {
  const archDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const start = path.join(__dirname, '..', '..', 'dist', archDir);
  const appPath = findApp(fs.existsSync(start) ? start : path.join(__dirname, '..', '..', 'dist'));
  if (!appPath) { console.log('PACKAGED PTY: FAIL — no .app in dist/'); return app.exit(1); }
  const ptyPath = path.join(appPath, 'Contents', 'Resources', 'app', 'node_modules', 'node-pty');
  let pty;
  try { pty = require(ptyPath); } catch (e) { console.log('PACKAGED PTY: FAIL — require: ' + e.message); return app.exit(1); }
  let out = '', p;
  try {
    p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l', '-i'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.HOME, env: process.env });
  } catch (e) { console.log('PACKAGED PTY: FAIL — spawn: ' + e.message); return app.exit(1); }
  p.onData((d) => {
    out += d;
    if (out.indexOf('PKG_PTY_OK_9') !== -1) { console.log('PACKAGED PTY: PASS — packaged node-pty spawned a shell'); try { p.kill(); } catch (e) {} app.exit(0); }
  });
  setTimeout(() => { if (p) p.write('echo PKG_PTY_OK_$((4+5))\r'); }, 500);
  setTimeout(() => { console.log('PACKAGED PTY: FAIL — timeout'); app.exit(2); }, 15000);
});
