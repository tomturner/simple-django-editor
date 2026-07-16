'use strict';

/* globals Terminal, FitAddon */

const term = new Terminal({
  fontSize: 13,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  cursorBlink: true,
  theme: { background: '#1e1f22', foreground: '#dfe1e5', cursor: '#dfe1e5' }
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

const pick = document.getElementById('pick');
let commands = [];

function dims() {
  try { const d = fit.proposeDimensions(); if (d && d.cols && d.rows) return d; } catch (e) { /* not ready */ }
  return { cols: 80, rows: 24 };
}
function doFit() {
  try { fit.fit(); } catch (e) { return; }
  const d = dims();
  window.api.ccResize({ cols: d.cols, rows: d.rows });
}

async function start(command) {
  term.reset();
  const d = dims();
  const res = await window.api.ccStart({ command: command, cols: d.cols, rows: d.rows });
  if (res && res.cwd) document.getElementById('cwd').textContent = res.cwd;
  term.focus();
}

// Wire the terminal to the PTY.
term.onData((data) => window.api.ccInput(data));
window.api.onCcData((d) => term.write(d));
window.api.onCcExit((info) => {
  term.write('\r\n\x1b[90m[process exited' + (info && info.code != null ? ' (' + info.code + ')' : '') + '] — press Restart\x1b[0m\r\n');
});

pick.addEventListener('change', () => { const c = commands[pick.selectedIndex]; if (c) start(c.command); });
document.getElementById('restart').addEventListener('click', () => { const c = commands[pick.selectedIndex]; start(c ? c.command : ''); });

window.addEventListener('resize', doFit);
setTimeout(doFit, 0);

window.api.ccCommands().then((info) => {
  commands = (info && info.commands) || [];
  pick.innerHTML = '';
  if (info && info.cwd) document.getElementById('cwd').textContent = info.cwd;
  if (!commands.length) {
    term.write('\x1b[33mNo Claude command configured.\x1b[0m\r\n');
    term.write('Set one in the main window: ⚙ Settings → Claude commands.\r\n');
    return;
  }
  commands.forEach((c) => { const o = document.createElement('option'); o.textContent = c.name; pick.appendChild(o); });
  let idx = commands.findIndex((c) => c.isDefault);
  if (idx < 0) idx = 0;
  pick.selectedIndex = idx;
  // Give the layout a tick to settle so the initial PTY size is right.
  setTimeout(() => { doFit(); start(commands[idx].command); }, 30);
});
