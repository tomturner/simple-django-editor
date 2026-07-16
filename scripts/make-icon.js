'use strict';
// Generates build/icon.png (1024x1024) for the app icon by drawing it on a
// canvas in a headless Electron window. Run with: electron scripts/make-icon.js
// Then build/icon.icns is produced from it (see package.json "iconset" note).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="1024" height="1024"></canvas>
<script>
const cv = document.getElementById('c');
const x = cv.getContext('2d');
const S = 1024;
function rr(x0, y0, w, h, r) {
  x.beginPath();
  x.moveTo(x0 + r, y0);
  x.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  x.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  x.arcTo(x0, y0 + h, x0, y0, r);
  x.arcTo(x0, y0, x0 + w, y0, r);
  x.closePath();
}
// Dark rounded-square background with a subtle vertical gradient.
const g = x.createLinearGradient(0, 0, 0, S);
g.addColorStop(0, '#33363b');
g.addColorStop(1, '#191a1c');
rr(0, 0, S, S, S * 0.225);
x.fillStyle = g;
x.fill();
// Thin browser-window hint: three dots top-left.
const dotY = S * 0.2, dr = S * 0.022;
['#e06c60', '#e6b34a', '#5aad5f'].forEach((c, i) => {
  x.beginPath();
  x.arc(S * 0.235 + i * S * 0.075, dotY, dr, 0, Math.PI * 2);
  x.fillStyle = c;
  x.fill();
});
// Green "run" play triangle (rounded), matching the app's Run button.
x.save();
x.translate(S * 0.535, S * 0.55);
const t = S * 0.2;
const grad = x.createLinearGradient(-t, -t, t, t);
grad.addColorStop(0, '#5aad5f');
grad.addColorStop(1, '#3f8f44');
x.beginPath();
x.moveTo(-t * 0.9, -t);
x.lineTo(t, 0);
x.lineTo(-t * 0.9, t);
x.closePath();
x.lineJoin = 'round';
x.lineWidth = S * 0.085;
x.strokeStyle = grad;
x.fillStyle = grad;
x.stroke();
x.fill();
x.restore();
window._png = cv.toDataURL('image/png');
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: {} });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const dataUrl = await win.webContents.executeJavaScript('window._png');
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), Buffer.from(b64, 'base64'));
  console.log('wrote build/icon.png');
  app.exit(0);
});
