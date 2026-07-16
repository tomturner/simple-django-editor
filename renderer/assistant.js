'use strict';

const pick = document.getElementById('pick');
const wv = document.getElementById('wv');
const empty = document.getElementById('empty');
let assistants = [];
let ready = false;      // webview guest attached
let pendingUrl = null;  // url requested before the guest was ready

function load(url) {
  if (!url) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  if (ready) wv.setAttribute('src', url);
  else pendingUrl = url; // navigate once dom-ready fires
}

wv.addEventListener('dom-ready', () => {
  ready = true;
  if (pendingUrl) { const u = pendingUrl; pendingUrl = null; wv.setAttribute('src', u); }
});
wv.addEventListener('did-navigate', () => { empty.style.display = 'none'; });
document.getElementById('reload').addEventListener('click', () => { try { wv.reload(); } catch (e) {} });
document.getElementById('ext').addEventListener('click', () => {
  const a = assistants[pick.selectedIndex];
  if (a) window.api.openDownload(a.url); // reuse: opens a URL in the default browser
});
pick.addEventListener('change', () => {
  const a = assistants[pick.selectedIndex];
  if (a) load(a.url);
});

window.api.assistantList().then((list) => {
  assistants = list || [];
  pick.innerHTML = '';
  if (!assistants.length) { empty.style.display = 'flex'; return; }
  assistants.forEach((a) => {
    const o = document.createElement('option');
    o.textContent = a.name;
    pick.appendChild(o);
  });
  let idx = assistants.findIndex((a) => a.isDefault);
  if (idx < 0) idx = 0;
  pick.selectedIndex = idx;
  load(assistants[idx].url);
});
