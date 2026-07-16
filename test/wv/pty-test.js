'use strict';
// Verifies node-pty loads under Electron and can spawn a working PTY.
const { app } = require('electron');

app.whenReady().then(() => {
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    console.log('PTY TEST: FAIL — require failed: ' + e.message);
    return app.exit(1);
  }
  const shell = process.env.SHELL || '/bin/zsh';
  let out = '';
  let p;
  try {
    p = pty.spawn(shell, ['-lic', 'echo PTY_OK_$((3+4)); exit'], {
      name: 'xterm-color', cols: 80, rows: 24, cwd: process.env.HOME, env: process.env
    });
  } catch (e) {
    console.log('PTY TEST: FAIL — spawn failed: ' + e.message);
    return app.exit(1);
  }
  p.onData((d) => { out += d; });
  p.onExit(() => {
    const ok = out.indexOf('PTY_OK_7') !== -1;
    console.log('PTY TEST: ' + (ok ? 'PASS' : 'FAIL') + '  captured=' + JSON.stringify(out.slice(-60)));
    app.exit(ok ? 0 : 1);
  });
  setTimeout(() => { console.log('PTY TEST: TIMEOUT'); app.exit(2); }, 15000);
});
