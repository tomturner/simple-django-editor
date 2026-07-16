'use strict';
// electron-builder afterPack hook: node-pty ships a `spawn-helper` binary that
// must be executable, but the prebuilt copies lose their execute bit when
// packaged — causing `posix_spawnp failed` at runtime. Mark every bundled
// spawn-helper executable so whichever node-pty loads, it can spawn a shell.

const fs = require('fs');
const path = require('path');

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  let apps = [];
  try { apps = fs.readdirSync(appOutDir).filter((f) => f.endsWith('.app')); } catch (e) { /* ignore */ }
  let count = 0;
  for (const appName of apps) {
    const ptyDir = path.join(appOutDir, appName, 'Contents', 'Resources', 'app', 'node_modules', 'node-pty');
    for (const file of walk(ptyDir)) {
      if (path.basename(file) === 'spawn-helper') {
        try { fs.chmodSync(file, 0o755); count++; } catch (e) { /* ignore */ }
      }
    }
  }
  console.log('afterPack: made ' + count + ' spawn-helper binary(ies) executable');
};
