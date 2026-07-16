'use strict';
// Verifies the auto-updater's download + ditto-extract chain against a real
// release asset (the v1.0.2 arm64 zip), and that the extracted app is valid
// with an executable spawn-helper. Run with: node test/wv/download-extract-test.js

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = 'https://github.com/tomturner/simple-django-editor/releases/download/v1.0.2/Simple.Django.Editor-1.0.2-arm64.zip';

function downloadFile(url, dest, onProgress, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'sde' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume(); return resolve(downloadFile(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const total = parseInt(res.headers['content-length'] || '0', 10); let got = 0, last = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; const p = total ? Math.round(got / total * 100) : 0; if (p >= last + 25) { last = p; onProgress(p); } });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}
function execP(cmd, args) {
  return new Promise((resolve, reject) => { const p = spawn(cmd, args); let e = ''; p.stderr.on('data', (d) => e += d); p.on('close', (c) => c === 0 ? resolve() : reject(new Error(cmd + ' ' + c + ': ' + e))); p.on('error', reject); });
}

(async () => {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sde-dl-'));
    const zip = path.join(tmp, 'u.zip');
    console.log('downloading…');
    await downloadFile(URL_, zip, (p) => console.log('  ' + p + '%'));
    console.log('extracting with ditto…');
    await execP('/usr/bin/ditto', ['-x', '-k', zip, tmp]);
    const appName = fs.readdirSync(tmp).find((f) => f.endsWith('.app'));
    if (!appName) throw new Error('no .app extracted');
    const helper = path.join(tmp, appName, 'Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper');
    const execOk = fs.existsSync(helper) && !!(fs.statSync(helper).mode & 0o111);
    console.log('DOWNLOAD+EXTRACT TEST: PASS — got ' + appName + '; spawn-helper executable=' + execOk);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(execOk ? 0 : 1);
  } catch (e) {
    console.log('DOWNLOAD+EXTRACT TEST: FAIL — ' + e.message);
    process.exit(1);
  }
})();
