'use strict';

/* globals Terminal, FitAddon, CodeMirror */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let store = { settings: {}, configs: [], lastConfigId: null };
let currentId = null;
let running = false;
let editingId = null;       // run-config id being edited in the modal, or null
let parsedServices = [];    // [{name, ports}] from the last compose parse
let editorTabsWork = [];    // working copy of browser tabs while editing a config
let projectRoot = null;     // folder shown in the file tree
let latestUpdate = null;    // last update-check result
let appVersion = '';        // this app's version

// Editor tabs
let tabs = [];              // { id, path, name, doc, dirty, dotEl }
let activeTabId = null;
let browserActive = false;  // (tabs layout) browser tab is the active one
let tabSeq = 1;

const $ = (id) => document.getElementById(id);

function baseName(p) { return String(p).replace(/[\/\\]+$/, '').split(/[\/\\]/).pop(); }
function dirName(p) {
  const parts = String(p).replace(/[\/\\]+$/, '').split(/[\/\\]/);
  parts.pop();
  return parts.join('/') || '/';
}
function layoutMode() { return store.settings.layoutMode || 'split'; }
function autoSaveOn() { return store.settings.autoSave !== false; }

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
const term = new Terminal({
  convertEol: true,
  cursorBlink: false,
  fontSize: 13,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  theme: { background: '#1e1f22', foreground: '#dfe1e5', cursor: '#dfe1e5' }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($('term'));
setTimeout(safeFit, 0);
function safeFit() { try { fitAddon.fit(); } catch (e) { /* not visible */ } }
term.onData((data) => { if (running) window.api.termInput(data); });

// ---------------------------------------------------------------------------
// Code editor (CodeMirror) + tabs
// ---------------------------------------------------------------------------
const editor = CodeMirror($('editorHost'), {
  value: '',
  mode: null,
  theme: 'material-darker',
  lineNumbers: true,
  indentUnit: 4,
  lineWrapping: false
});
editor.setSize('100%', '100%');
const emptyDoc = editor.getDoc();

// Save the active tab whenever the editor loses focus (PyCharm-style).
editor.on('blur', () => { if (autoSaveOn()) saveActiveTab(); });

const emptyHint = document.createElement('div');
emptyHint.className = 'empty-hint';
emptyHint.textContent = 'Select a file from the tree to edit it';
$('editorHost').appendChild(emptyHint);

function modeFor(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': return { name: 'javascript', typescript: true };
    case 'json': return { name: 'javascript', json: true };
    case 'html': case 'htm': case 'jinja': case 'j2': case 'dtl': return 'htmlmixed';
    case 'css': case 'scss': case 'less': return 'css';
    case 'xml': case 'svg': return 'xml';
    case 'yml': case 'yaml': return 'yaml';
    case 'md': case 'markdown': return 'markdown';
    case 'sh': case 'bash': case 'zsh': case 'env': return 'shell';
    case 'sql': return 'sql';
    case 'c': case 'h': case 'cpp': case 'java': return 'clike';
    default: return null;
  }
}

function activeTab() { return tabs.find((t) => t.id === activeTabId) || null; }

async function openFile(filePath, jump) {
  let tab = tabs.find((t) => t.path === filePath);
  if (!tab) {
    const res = await window.api.readFile(filePath);
    if (!res.ok) { alert(res.error); return; }
    const doc = CodeMirror.Doc(res.content, modeFor(filePath));
    tab = { id: 't' + (tabSeq++), path: filePath, name: baseName(filePath), doc, dirty: false, dotEl: null };
    doc.on('change', () => onDocChange(tab));
    tabs.push(tab);
    renderTabBar();
  }
  activateTab(tab.id, jump);
}

function onDocChange(tab) {
  if (!tab.dirty) { tab.dirty = true; if (tab.dotEl) tab.dotEl.style.visibility = 'visible'; }
  if (tab.id === activeTabId) $('btnSaveFile').disabled = false;
}

function activateTab(id, jump) {
  const prev = activeTab();
  if (prev && prev.id !== id && autoSaveOn()) saveTab(prev);

  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeTabId = id;
  browserActive = false;
  editor.swapDoc(tab.doc);
  emptyHint.style.display = 'none';
  $('btnSaveFile').disabled = !tab.dirty;
  highlightActive(tab.path);
  updateTitle();
  updateLayout();
  renderTabBar();
  setTimeout(() => {
    editor.refresh();
    if (jump) {
      const pos = { line: jump.line, ch: jump.ch };
      editor.setCursor(pos);
      editor.scrollIntoView(pos, 120);
      if (jump.length) editor.setSelection(pos, { line: jump.line, ch: jump.ch + jump.length });
    }
    editor.focus();
  }, 0);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  if (tab.dirty) {
    if (autoSaveOn()) saveTab(tab);
    else if (!confirm(`Discard unsaved changes in ${tab.name}?`)) return;
  }
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    activeTabId = null;
    const next = tabs[idx] || tabs[idx - 1];
    if (next) activateTab(next.id);
    else {
      editor.swapDoc(emptyDoc);
      emptyDoc.setValue('');
      emptyHint.style.display = '';
      $('btnSaveFile').disabled = true;
      highlightActive(null);
      updateTitle();
      updateLayout();
    }
  }
  renderTabBar();
}

async function saveTab(tab) {
  if (!tab || !tab.dirty) return;
  const res = await window.api.writeFile(tab.path, tab.doc.getValue());
  if (!res.ok) { console.error('Save failed:', res.error); return; }
  tab.dirty = false;
  if (tab.dotEl) tab.dotEl.style.visibility = 'hidden';
  if (tab.id === activeTabId) $('btnSaveFile').disabled = true;
}
function saveActiveTab() { const t = activeTab(); if (t) saveTab(t); }
function saveAllDirty() { tabs.filter((t) => t.dirty).forEach(saveTab); }

function renderTabBar() {
  const bar = $('tabBar');
  bar.innerHTML = '';
  if (layoutMode() === 'tabs') {
    const bt = document.createElement('div');
    bt.className = 'etab' + (browserActive ? ' active' : '');
    bt.innerHTML = '<span class="etab-name">🌐 Browser</span>';
    bt.addEventListener('click', activateBrowser);
    bar.appendChild(bt);
  }
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'etab' + (!browserActive && tab.id === activeTabId ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'etab-name';
    name.textContent = tab.name;
    name.title = tab.path;
    const dot = document.createElement('span');
    dot.className = 'etab-dirty';
    dot.textContent = '●';
    dot.style.visibility = tab.dirty ? 'visible' : 'hidden';
    const close = document.createElement('span');
    close.className = 'etab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(name);
    el.appendChild(dot);
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(tab.id));
    tab.dotEl = dot;
    bar.appendChild(el);
  }
}

function highlightActive(filePath) {
  document.querySelectorAll('.tree-row.file').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === filePath);
  });
}

// Window title: "<file> — <project> — Simple Django Editor"
function updateTitle() {
  const parts = [];
  const t = activeTab();
  if (t) parts.push(t.name);
  if (projectRoot) parts.push(baseName(projectRoot));
  parts.push('Simple Django Editor');
  document.title = parts.join(' — ');
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------
async function openProject(rootPath) {
  if (!rootPath) return;
  projectRoot = rootPath;
  $('projectName').textContent = baseName(rootPath) || rootPath;
  $('projectName').title = rootPath;
  updateTitle();
  const tree = $('tree');
  tree.innerHTML = '';
  const root = createTreeItem({ name: baseName(rootPath), path: rootPath, isDir: true }, 0);
  tree.appendChild(root.item);
  root.toggle();
}

function createTreeItem(entry, depth) {
  const item = document.createElement('div');
  item.className = 'tree-item';

  const row = document.createElement('div');
  row.className = 'tree-row ' + (entry.isDir ? 'dir' : 'file');
  row.style.paddingLeft = (depth * 14 + 8) + 'px';
  row.title = entry.path;
  row.dataset.path = entry.path;

  const tw = document.createElement('span');
  tw.className = 'twisty';
  tw.textContent = entry.isDir ? '▸' : '';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = entry.name;
  row.appendChild(tw);
  row.appendChild(label);
  item.appendChild(row);

  let childrenEl = null;
  let loaded = false;
  let open = false;

  async function toggle() {
    if (!entry.isDir) return;
    open = !open;
    tw.textContent = open ? '▾' : '▸';
    if (open) {
      if (!childrenEl) {
        childrenEl = document.createElement('div');
        childrenEl.className = 'tree-children';
        item.appendChild(childrenEl);
      }
      if (!loaded) {
        loaded = true;
        const res = await window.api.readdir(entry.path);
        if (res.ok) {
          for (const child of res.entries) childrenEl.appendChild(createTreeItem(child, depth + 1).item);
        } else {
          const err = document.createElement('div');
          err.className = 'tree-row';
          err.style.paddingLeft = ((depth + 1) * 14 + 8) + 'px';
          err.textContent = res.error;
          childrenEl.appendChild(err);
        }
      }
      childrenEl.style.display = '';
    } else if (childrenEl) {
      childrenEl.style.display = 'none';
    }
  }

  row.addEventListener('click', () => { if (entry.isDir) toggle(); else openFile(entry.path); });
  return { item, toggle };
}

// ---------------------------------------------------------------------------
// Command preview
// ---------------------------------------------------------------------------
function tokenize(str) {
  const tokens = [];
  let current = '', quote = null, has = false;
  for (const ch of str || '') {
    if (quote) { if (ch === quote) quote = null; else current += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (ch === ' ' || ch === '\t') { if (has) { tokens.push(current); current = ''; has = false; } }
    else { current += ch; has = true; }
  }
  if (has) tokens.push(current);
  return tokens;
}
function quoteArg(s) { return /\s/.test(s) ? `"${s}"` : s; }
function previewCommand(cfg) {
  const compose = store.settings.composeCmd || 'docker compose';
  const parts = [compose, '-f', quoteArg(cfg.composeFile || '<compose file>'), 'run', '--rm'];
  if (cfg.hostPort && cfg.containerPort) parts.push('-p', `${cfg.hostPort}:${cfg.containerPort}`);
  if (cfg.extraArgs && cfg.extraArgs.trim()) parts.push(cfg.extraArgs.trim());
  parts.push(cfg.service || '<service>');
  if (cfg.command) parts.push(cfg.command);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Config select
// ---------------------------------------------------------------------------
function renderConfigSelect() {
  const sel = $('configSelect');
  sel.innerHTML = '';
  if (!store.configs.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No configurations — click ＋ New';
    opt.value = '';
    sel.appendChild(opt);
    return;
  }
  for (const cfg of store.configs) {
    const opt = document.createElement('option');
    opt.value = cfg.id;
    opt.textContent = cfg.name || '(unnamed)';
    sel.appendChild(opt);
  }
  if (currentId) sel.value = currentId;
}
function currentConfig() { return store.configs.find((c) => c.id === currentId) || null; }

function selectConfig(id) {
  currentId = id;
  store.lastConfigId = id;
  persist();
  renderConfigSelect();
  const cfg = currentConfig();
  if (cfg) {
    buildBrowserTabs(configBrowserTabs(cfg));
    const root = cfg.projectRoot || (cfg.composeFile ? dirName(cfg.composeFile) : null);
    if (root && root !== projectRoot) openProject(root);
  }
}
async function persist() { await window.api.saveStore(store); }

// ---------------------------------------------------------------------------
// Run / stop
// ---------------------------------------------------------------------------
async function run() {
  const cfg = currentConfig();
  if (!cfg) { openConfigEditor(null); return; }
  if (!cfg.composeFile || !cfg.service) {
    term.writeln('\x1b[31m[sde] This configuration needs a compose file and a service.\x1b[0m');
    openConfigEditor(cfg.id);
    return;
  }
  term.clear();
  const res = await window.api.runStart({ config: cfg, settings: store.settings });
  if (!res.ok) { term.writeln(`\x1b[31m[sde] ${res.error}\x1b[0m`); return; }
  setRunning(true);
  bootDetected = false;
  bootBuf = '';
  // Reuse the tab webviews built when the config was selected — recreating them
  // here would navigate them before they've attached (they'd stay blank).
  if (!bTabs.length) buildBrowserTabs(configBrowserTabs(cfg));
  const def = bTabs.find((t) => t.isDefault) || bTabs[0];
  if (def) activateBrowserTab(def.id);
  if (layoutMode() === 'tabs') activateBrowser();
  // Show the splash right away; the retry loop loads the real URLs and keeps
  // trying until each returns real (non-empty) content.
  bTabs.forEach((t) => { t.ok = false; showSplash(t); });
  startBootReload();
}
async function stop() { clearInterval(bootTimer); bootTimer = null; await window.api.runStop(); $('termStatus').textContent = 'stopping…'; }
function setRunning(on) {
  running = on;
  $('btnRun').disabled = on;
  $('btnStop').disabled = !on;
  const s = $('status');
  s.textContent = on ? 'running' : 'idle';
  s.className = 'status' + (on ? ' running' : '');
  $('termStatus').textContent = on ? 'process running' : '';
}

// ---------------------------------------------------------------------------
// Embedded browser — multiple tabs
// ---------------------------------------------------------------------------
let bTabs = [];            // { id, name, url, isDefault, wv, loaded, auto, ok, failed }
let activeBTab = null;
let bSeq = 1;
let bootTimer = null;      // retries tab loads while the server boots
let bootDetected = false;  // server "ready" line seen this run
let bootBuf = '';          // rolling, ANSI-stripped tail of server output

// Keep (re)loading the real URL into any tab that isn't showing real content
// yet — until it is. A tab is "ok" only once it loads a non-empty page, so an
// empty warmup response (socket up, app not ready) keeps retrying. The
// `loading` guard means we never interrupt a load that's in progress.
function startBootReload() {
  clearInterval(bootTimer);
  let attempts = 0;
  bTabs.forEach((t) => { t.ok = false; });
  const tick = () => {
    if (!running) { clearInterval(bootTimer); bootTimer = null; return; }
    attempts++;
    for (const t of bTabs) if (!t.ok && !t.loading && t.url) loadInto(t, t.url);
    const withUrl = bTabs.filter((t) => t.url);
    if ((withUrl.length && withUrl.every((t) => t.ok)) || attempts > 100) {
      clearInterval(bootTimer);
      bootTimer = null;
    }
  };
  bootTimer = setInterval(tick, 1300);
  setTimeout(tick, 400); // first attempt shortly after the splash shows
}

// Called when the terminal shows the server is up — nudge any not-yet-loaded tab.
function reloadAllTabs() { bTabs.forEach((t) => { if (t.url && !t.ok && !t.loading) loadInto(t, t.url); }); }

function activeWebview() { const t = bTabs.find((x) => x.id === activeBTab); return t ? t.wv : null; }

// Resolve a tab URL: '' -> host-port root, '/path' -> host-port + path, else as-is.
function resolveTabUrl(cfg, url) {
  const base = `http://localhost:${(cfg && cfg.hostPort) || 8000}`;
  const u = (url || '').trim();
  if (!u) return base + '/';
  if (u.startsWith('/')) return base + u;
  if (!/^[a-z]+:\/\//i.test(u)) return 'http://' + u;
  return u;
}

// Map a tab's session choice to an Electron webview partition:
//  - shared      -> default session (shares cache/cookies with everything)
//  - persistent  -> its own session, saved to disk (a second logged-in user sticks)
//  - incognito   -> its own in-memory session, wiped on rebuild/quit
let partNonce = 1;
function partitionFor(cfg, session, idx, nonce) {
  const key = (cfg && cfg.id ? cfg.id : 'nocfg') + '-' + idx;
  if (session === 'persistent') return 'persist:sde-' + key;
  if (session === 'incognito') return 'sde-inc-' + key + '-' + nonce;
  return undefined; // shared
}
function sessionKind(partition) {
  if (!partition) return null;
  return partition.startsWith('persist:') ? 'persist' : 'incog';
}

// The browser-tab list for a config (with URLs resolved), falling back to the
// legacy single `url`/host-port when a config predates browser tabs.
function configBrowserTabs(cfg) {
  const nonce = partNonce++;
  if (cfg && Array.isArray(cfg.browserTabs) && cfg.browserTabs.length) {
    return cfg.browserTabs.map((t, i) => ({
      name: t.name || 'Tab',
      url: resolveTabUrl(cfg, t.url),
      isDefault: !!t.isDefault,
      partition: partitionFor(cfg, t.session, i, nonce)
    }));
  }
  return [{ name: 'App', url: resolveTabUrl(cfg, cfg && cfg.url), isDefault: true }];
}

function buildBrowserTabs(list) {
  $('browserViews').innerHTML = '';
  bTabs = [];
  activeBTab = null;
  for (const t of list) createBrowserTab(t.name, t.url, t.isDefault, t.partition);
  if (!bTabs.length) createBrowserTab('App', '', true);
  const def = bTabs.find((t) => t.isDefault) || bTabs[0];
  activateBrowserTab(def.id);
  renderBrowserStrip();
}

function createBrowserTab(name, url, isDefault, partition) {
  const wv = document.createElement('webview');
  wv.className = 'bwv';
  if (partition) wv.setAttribute('partition', partition); // must be set before attach
  wv.setAttribute('src', 'about:blank');
  wv.style.display = 'none';
  $('browserViews').appendChild(wv);
  const tab = { id: 'b' + (bSeq++), name: name || 'Tab', url: url || '', isDefault: !!isDefault, partition: partition || null, wv, auto: false, ok: false, loading: false };
  wv.addEventListener('did-start-loading', () => { tab.loading = true; tab.failedLoad = false; });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; });
  wv.addEventListener('did-finish-load', () => {
    const u = (typeof wv.getURL === 'function') ? wv.getURL() : '';
    if (!u || u === 'about:blank' || u.indexOf('data:') === 0) return; // splash/blank
    if (tab.failedLoad) return; // this "finish" is Chromium's error page for a failed load
    // Confirm the page has real content — the server can return an empty body
    // during the brief app warmup right after it binds the port. "Real" means
    // the body has children/text, or the document is substantial (e.g. a JS app
    // shell). An empty warmup response is a tiny, content-less document.
    wv.executeJavaScript(
      '(function(){try{var h=document.documentElement.outerHTML.length;'
      + 'var b=document.body;var c=b&&(b.children.length>0||b.innerText.trim().length>0);'
      + 'return h>=200||!!c;}catch(e){return true;}})()'
    )
      .then((real) => {
        if (real) { tab.ok = true; }
        else if (!tab.ok) { showSplash(tab); } // empty warmup → keep waiting
      })
      .catch(() => { tab.ok = true; });
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) {
      tab.failedLoad = true;                 // so the error page's did-finish-load is ignored
      if (!tab.ok) showSplash(tab);          // show the splash, not Chromium's error page
    }
  });
  wv.addEventListener('did-navigate', (e) => {
    if (e.url && e.url !== 'about:blank' && e.url.indexOf('data:') !== 0) {
      tab.url = e.url;
      if (tab.id === activeBTab) $('urlInput').value = e.url;
    }
  });
  wv.addEventListener('page-title-updated', (e) => {
    if (tab.auto && e.title) { tab.name = e.title.slice(0, 30); renderBrowserStrip(); }
  });
  bTabs.push(tab);
  return tab;
}

function activateBrowserTab(id) {
  activeBTab = id;
  for (const t of bTabs) t.wv.style.display = (t.id === id) ? '' : 'none';
  const t = bTabs.find((x) => x.id === id);
  if (t) $('urlInput').value = t.url || '';
  renderBrowserStrip();
}

// Load a URL into a tab. Uses loadURL (works once the webview has attached,
// which it has by run-time since tabs are built at select) and falls back to
// the src attribute if the webview isn't ready yet. No about:blank nudge — that
// aborts/re-requests fast enough to make some servers reset the connection.
function loadInto(tab, url) {
  try {
    const p = tab.wv.loadURL(url);
    if (p && p.catch) p.catch(() => {});
  } catch (e) {
    try { tab.wv.setAttribute('src', url); } catch (_) { /* not ready */ }
  }
}

// A local "waiting for the server" splash shown while the server boots (or
// returns empty warmup responses) so tabs never sit blank.
function splashDataUrl(name) {
  const html = '<!doctype html><html><body style="margin:0;height:100vh;display:flex;'
    + 'align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
    + 'background:#1e1f22;color:#9aa0a6"><div style="text-align:center">'
    + '<div style="width:24px;height:24px;border:3px solid #3574f0;border-top-color:transparent;'
    + 'border-radius:50%;margin:0 auto 14px;animation:sp .8s linear infinite"></div>'
    + '<div style="color:#dfe1e5;font-size:14px">Waiting for the server…</div>'
    + '<div style="font-size:12px;margin-top:5px">' + (name || '') + '</div></div>'
    + '<style>@keyframes sp{to{transform:rotate(360deg)}}</style></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}
function showSplash(tab) { if (tab) loadInto(tab, splashDataUrl(tab.name)); }

function navigateTab(tab, url) {
  if (!tab || !url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  tab.url = url;
  loadInto(tab, url);
}

function navigate(url) { const t = bTabs.find((x) => x.id === activeBTab); if (t) navigateTab(t, url); }

function closeBrowserTab(id) {
  if (bTabs.length <= 1) return;
  const idx = bTabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [t] = bTabs.splice(idx, 1);
  clearTimeout(t.retry);
  t.wv.remove();
  if (activeBTab === id) { const n = bTabs[idx] || bTabs[idx - 1]; activateBrowserTab(n.id); }
  renderBrowserStrip();
}

function currentBaseUrl() { return resolveTabUrl(currentConfig(), ''); }

function renderBrowserStrip() {
  const strip = $('browserTabStrip');
  strip.innerHTML = '';
  for (const t of bTabs) {
    const el = document.createElement('div');
    const kind = sessionKind(t.partition);
    el.className = 'btab' + (t.id === activeBTab ? ' active' : '') + (kind ? ' ' + kind : '');
    if (kind) {
      const sym = document.createElement('span');
      sym.className = 'btab-sym';
      sym.textContent = kind === 'incog' ? '🕶' : '👤';
      sym.title = kind === 'incog' ? 'Incognito session (not saved)' : 'Separate saved login';
      el.appendChild(sym);
    }
    const nm = document.createElement('span');
    nm.className = 'btab-name';
    nm.textContent = t.name;
    nm.title = (t.url || t.name) + (kind === 'incog' ? '  ·  incognito' : kind === 'persist' ? '  ·  separate login' : '');
    el.appendChild(nm);
    if (bTabs.length > 1) {
      const c = document.createElement('span');
      c.className = 'btab-close';
      c.textContent = '×';
      c.addEventListener('click', (e) => { e.stopPropagation(); closeBrowserTab(t.id); });
      el.appendChild(c);
    }
    el.addEventListener('click', () => { activateBrowserTab(t.id); if (!t.ok && t.url) navigateTab(t, t.url); });
    strip.appendChild(el);
  }
  const add = document.createElement('div');
  add.className = 'btab btab-add';
  add.textContent = '＋';
  add.title = 'New tab';
  add.addEventListener('click', () => {
    const tab = createBrowserTab('New tab', currentBaseUrl(), false);
    tab.auto = true;
    activateBrowserTab(tab.id);
    navigateTab(tab, tab.url);
    renderBrowserStrip();
  });
  strip.appendChild(add);
}

// ---------------------------------------------------------------------------
// Layout + panel toggles
// ---------------------------------------------------------------------------
function view() {
  if (!store.settings.view) store.settings.view = { files: true, browser: true, terminal: true };
  return store.settings.view;
}
function setPanel(paneId, splitterId, on) {
  $(paneId).style.display = on ? '' : 'none';
  if (splitterId) $(splitterId).style.display = on ? '' : 'none';
}
function activateBrowser() {
  if (layoutMode() !== 'tabs') return;
  browserActive = true;
  if (autoSaveOn()) saveActiveTab();
  updateLayout();
  renderTabBar();
}
function updateLayout() {
  const v = view();
  const topArea = $('topArea');
  const browserPane = $('browserPane');
  if (layoutMode() === 'tabs') {
    topArea.classList.add('tabs-mode');
    browserPane.classList.remove('solo');
    $('hsplit').style.display = 'none';
    $('editorPane').style.display = browserActive ? 'none' : '';
    browserPane.style.display = browserActive ? '' : 'none';
  } else {
    topArea.classList.remove('tabs-mode');
    const showEditor = v.editor !== false;
    const showBrowser = v.browser !== false;
    $('editorPane').style.display = showEditor ? '' : 'none';
    browserPane.style.display = showBrowser ? '' : 'none';
    $('hsplit').style.display = (showEditor && showBrowser) ? '' : 'none';
    // If only the browser is showing, let it fill the row instead of its fixed width.
    browserPane.classList.toggle('solo', showBrowser && !showEditor);
  }
  updateToggleButtons();
  setTimeout(() => { safeFit(); editor.refresh(); }, 0);
}
function updateToggleButtons() {
  const v = view();
  const tabsMode = layoutMode() === 'tabs';
  $('tgFiles').classList.toggle('on', v.files !== false);
  $('tgTerminal').classList.toggle('on', v.terminal !== false);
  $('tgLayout').textContent = tabsMode ? 'Tabs' : 'Split';
  // Editor toggle only applies in split mode; in tabs mode the tabs decide.
  $('tgEditor').disabled = tabsMode;
  $('tgEditor').classList.toggle('on', tabsMode ? !browserActive : v.editor !== false);
  const browserOn = tabsMode ? browserActive : v.browser !== false;
  $('tgBrowser').classList.toggle('on', browserOn);
}
function applyView() {
  const v = view();
  setPanel('sidebar', 'vsplit', v.files !== false);
  setPanel('termPane', 'resizer', v.terminal !== false);
  updateLayout();
}
function toggleFiles() { const v = view(); v.files = v.files === false; persist(); setPanel('sidebar', 'vsplit', v.files); updateToggleButtons(); setTimeout(() => { safeFit(); editor.refresh(); }, 0); }
function toggleTerminal() { const v = view(); v.terminal = v.terminal === false; persist(); setPanel('termPane', 'resizer', v.terminal); updateToggleButtons(); setTimeout(safeFit, 0); }
function toggleBrowser() {
  if (layoutMode() === 'tabs') { activateBrowser(); return; }
  const v = view();
  v.browser = v.browser === false;
  persist();
  updateLayout();
}
function toggleEditor() {
  if (layoutMode() === 'tabs') return; // tabs decide in tabs mode
  const v = view();
  v.editor = v.editor === false;
  if (v.editor && autoSaveOn()) { /* editor shown again */ }
  persist();
  updateLayout();
}
function toggleLayout() {
  store.settings.layoutMode = layoutMode() === 'tabs' ? 'split' : 'tabs';
  if (layoutMode() === 'tabs' && !activeTabId) browserActive = true;
  persist();
  renderTabBar();
  updateLayout();
}

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------
// A single drag manager. The overlay covers the whole window (including the
// embedded webview) while dragging, so mousemove/mouseup always reach us —
// otherwise the webview swallows them and the drag never ends.
let dragMove = null;
function beginDrag(orientation, onMove) {
  dragMove = onMove;
  const ov = $('dragOverlay');
  ov.className = 'active ' + (orientation === 'col' ? 'col' : 'row');
}
function endDrag() {
  if (!dragMove) return;
  dragMove = null;
  $('dragOverlay').className = '';
  editor.refresh();
  safeFit();
}
window.addEventListener('mousemove', (e) => { if (dragMove) { e.preventDefault(); dragMove(e); } });
window.addEventListener('mouseup', endDrag);
window.addEventListener('mouseleave', endDrag);

function makeVSplitter(splitterId, paneId, side) {
  const pane = $(paneId);
  $(splitterId).addEventListener('mousedown', (e) => {
    e.preventDefault();
    beginDrag('col', (ev) => {
      const rect = pane.getBoundingClientRect();
      const w = side === 'left' ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
      pane.style.width = Math.max(120, w) + 'px';
      safeFit();
    });
  });
}
function makeHSplitter() {
  const pane = $('termPane');
  $('resizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    beginDrag('row', (ev) => {
      const rect = $('mainArea').getBoundingClientRect();
      pane.style.height = Math.max(60, rect.bottom - ev.clientY) + 'px';
      safeFit();
    });
  });
}

// ---------------------------------------------------------------------------
// Find in Files (Shift-Shift)
// ---------------------------------------------------------------------------
let findTimer = null;
let findItems = [];   // flat list of navigable results { path, line, ch, length }
let findSel = 0;

function openFind() {
  $('findOverlay').classList.remove('hidden');
  const input = $('findInput');
  input.focus();
  input.select();
  runFind();
}
function closeFind() { $('findOverlay').classList.add('hidden'); }

function runFind() {
  clearTimeout(findTimer);
  findTimer = setTimeout(doFind, 180);
}
async function doFind() {
  const q = $('findInput').value;
  const results = $('findResults');
  if (!projectRoot) { results.innerHTML = ''; $('findStatus').textContent = 'Open a project folder first.'; return; }
  if (q.length < 2) { results.innerHTML = ''; findItems = []; $('findStatus').textContent = 'Type at least 2 characters…'; return; }
  $('findStatus').textContent = 'Searching…';
  const res = await window.api.searchProject(projectRoot, q, $('findCase').checked);
  renderFindResults(res, q);
}

function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function highlight(line, col, len) {
  return esc(line.slice(0, col)) + '<mark>' + esc(line.slice(col, col + len)) + '</mark>' + esc(line.slice(col + len));
}

function renderFindResults(res, query) {
  const results = $('findResults');
  results.innerHTML = '';
  findItems = [];
  findSel = 0;

  if (res.files && res.files.length) {
    const g = document.createElement('div');
    g.className = 'find-group';
    g.textContent = `Files (${res.files.length})`;
    results.appendChild(g);
    for (const f of res.files) {
      const item = makeFindItem(f.rel, '', { path: f.path, line: 0, ch: 0, length: 0 });
      results.appendChild(item);
    }
  }

  if (res.matches && res.matches.length) {
    const g = document.createElement('div');
    g.className = 'find-group';
    g.textContent = `In files (${res.matches.length}${res.truncated ? '+' : ''})`;
    results.appendChild(g);
    for (const m of res.matches) {
      const loc = `${m.rel}:${m.lineNumber}`;
      const item = makeFindItem(loc, highlight(m.line, m.col, query.length), { path: m.path, line: m.lineNumber - 1, ch: m.col, length: query.length });
      results.appendChild(item);
    }
  }

  const total = findItems.length;
  $('findStatus').textContent = total
    ? `${total} result${total === 1 ? '' : 's'}${res.truncated ? ' (showing first matches)' : ''} — ↑↓ to move, Enter to open`
    : 'No matches.';
  updateFindSelection();
}

function makeFindItem(locText, htmlText, target) {
  const idx = findItems.length;
  findItems.push(target);
  const item = document.createElement('div');
  item.className = 'find-item';
  item.dataset.idx = idx;
  const loc = document.createElement('span');
  loc.className = 'find-loc';
  loc.textContent = locText;
  item.appendChild(loc);
  if (htmlText) {
    const txt = document.createElement('span');
    txt.className = 'find-text';
    txt.innerHTML = htmlText;
    item.appendChild(txt);
  }
  item.addEventListener('mouseenter', () => { findSel = idx; updateFindSelection(); });
  item.addEventListener('click', () => openFindItem(idx));
  return item;
}

function updateFindSelection() {
  const items = $('findResults').querySelectorAll('.find-item');
  items.forEach((el) => el.classList.toggle('sel', Number(el.dataset.idx) === findSel));
  const sel = $('findResults').querySelector('.find-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function openFindItem(idx) {
  const t = findItems[idx];
  if (!t) return;
  closeFind();
  openFile(t.path, t.length ? { line: t.line, ch: t.ch, length: t.length } : undefined);
}

// ---------------------------------------------------------------------------
// Run-config editor modal
// ---------------------------------------------------------------------------
function openConfigEditor(id) {
  editingId = id;
  const cfg = id ? store.configs.find((c) => c.id === id) : null;
  $('editorTitle').textContent = cfg ? 'Edit configuration' : 'New configuration';
  $('fName').value = cfg ? (cfg.name || '') : 'Django server';
  $('fCompose').value = cfg ? (cfg.composeFile || '') : '';
  $('fCommand').value = cfg ? (cfg.command || '') : 'python manage.py runserver 0.0.0.0:8000';
  $('fHostPort').value = cfg ? (cfg.hostPort || '') : '8000';
  $('fContainerPort').value = cfg ? (cfg.containerPort || '') : '8000';
  $('fExtra').value = cfg ? (cfg.extraArgs || '') : '';
  editorTabsWork = configEditorSeed(cfg);
  renderEditorTabs();
  parsedServices = [];
  populateServiceSelect(cfg ? cfg.service : null);
  refreshPreview();
  if (cfg && cfg.composeFile) parseServices(cfg.composeFile, cfg.service);
  $('editorOverlay').classList.remove('hidden');
  $('fName').focus();
}
function closeConfigEditor() { $('editorOverlay').classList.add('hidden'); }

// Seed the editor's browser-tab rows from a config (raw, unresolved URLs).
function configEditorSeed(cfg) {
  if (cfg && Array.isArray(cfg.browserTabs) && cfg.browserTabs.length) {
    return cfg.browserTabs.map((t) => ({ name: t.name || '', url: t.url || '', isDefault: !!t.isDefault, session: t.session || 'shared' }));
  }
  return [{ name: 'App', url: (cfg && cfg.url) || '', isDefault: true, session: 'shared' }];
}

function renderEditorTabs() {
  const list = $('tabsList');
  list.innerHTML = '';
  editorTabsWork.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const def = document.createElement('input');
    def.type = 'radio';
    def.name = 'defTab';
    def.checked = !!t.isDefault;
    def.title = 'Default (focused) tab';
    def.addEventListener('change', () => { editorTabsWork.forEach((x) => { x.isDefault = false; }); t.isDefault = true; });

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'tab-name';
    name.placeholder = 'Name';
    name.value = t.name || '';
    name.addEventListener('input', () => { t.name = name.value; });

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'tab-url';
    url.placeholder = '/admin/  or  https://dev.myapp.local';
    url.value = t.url || '';
    url.addEventListener('input', () => { t.url = url.value; });

    const session = document.createElement('select');
    session.className = 'tab-session';
    session.title = 'Session: shared cache, separate saved login, or incognito';
    [['shared', 'Shared'], ['persistent', 'Separate login 👤'], ['incognito', 'Incognito 🕶']].forEach(([val, lbl]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = lbl;
      if ((t.session || 'shared') === val) o.selected = true;
      session.appendChild(o);
    });
    session.addEventListener('change', () => { t.session = session.value; });

    const del = document.createElement('button');
    del.className = 'btn btn-ghost tiny tab-del';
    del.textContent = '×';
    del.title = 'Remove tab';
    del.addEventListener('click', () => {
      editorTabsWork.splice(i, 1);
      if (editorTabsWork.length && !editorTabsWork.some((x) => x.isDefault)) editorTabsWork[0].isDefault = true;
      renderEditorTabs();
    });

    row.append(def, name, url, session, del);
    list.appendChild(row);
  });
}

function populateServiceSelect(selected) {
  const sel = $('fService');
  sel.innerHTML = '';
  if (!parsedServices.length) {
    const opt = document.createElement('option');
    opt.value = selected || '';
    opt.textContent = selected || '(select a compose file first)';
    sel.appendChild(opt);
    if (selected) sel.value = selected;
    return;
  }
  for (const svc of parsedServices) {
    const opt = document.createElement('option');
    opt.value = svc.name;
    opt.textContent = svc.name;
    sel.appendChild(opt);
  }
  if (selected && parsedServices.some((s) => s.name === selected)) sel.value = selected;
}
async function parseServices(file, keepSelected) {
  const res = await window.api.parseCompose(file);
  if (!res.ok) { parsedServices = []; populateServiceSelect(keepSelected); return; }
  parsedServices = res.services;
  populateServiceSelect(keepSelected || $('fService').value);
  maybePrefillPorts();
  refreshPreview();
}
function maybePrefillPorts() {
  const name = $('fService').value;
  const svc = parsedServices.find((s) => s.name === name);
  if (!svc || !svc.ports || !svc.ports.length) return;
  const first = String(svc.ports[0]).replace(/^[\d.]+:(?=\d+:)/, '');
  const bits = first.split(':');
  if (!$('fHostPort').value && bits.length >= 2) $('fHostPort').value = bits[0];
  if (!$('fContainerPort').value) $('fContainerPort').value = bits[bits.length - 1];
}
function gatherEditor() {
  const tabsClean = editorTabsWork
    .map((t) => ({ name: (t.name || '').trim() || 'Tab', url: (t.url || '').trim(), isDefault: !!t.isDefault, session: t.session || 'shared' }))
    .filter((t) => t.url || t.name !== 'Tab');
  if (tabsClean.length && !tabsClean.some((t) => t.isDefault)) tabsClean[0].isDefault = true;
  const def = tabsClean.find((t) => t.isDefault) || tabsClean[0];
  return {
    name: $('fName').value.trim() || 'Untitled',
    composeFile: $('fCompose').value.trim(),
    service: $('fService').value,
    command: $('fCommand').value.trim(),
    hostPort: $('fHostPort').value.trim(),
    containerPort: $('fContainerPort').value.trim(),
    extraArgs: $('fExtra').value.trim(),
    browserTabs: tabsClean,
    url: def ? def.url : '' // kept for backward compatibility
  };
}
function refreshPreview() { $('cmdPreview').textContent = previewCommand(gatherEditor()); }
function saveConfigEditor() {
  const data = gatherEditor();
  if (!data.composeFile) { alert('Please select a compose file.'); return; }
  if (!data.service) { alert('Please select a service.'); return; }
  if (editingId) {
    Object.assign(store.configs.find((c) => c.id === editingId), data);
    currentId = editingId;
  } else {
    const cfg = Object.assign({ id: crypto.randomUUID() }, data);
    store.configs.push(cfg);
    currentId = cfg.id;
  }
  store.lastConfigId = currentId;
  persist();
  renderConfigSelect();
  selectConfig(currentId);
  closeConfigEditor();
}
function deleteCurrent() {
  const cfg = currentConfig();
  if (!cfg) return;
  if (!confirm(`Delete configuration "${cfg.name}"?`)) return;
  store.configs = store.configs.filter((c) => c.id !== cfg.id);
  currentId = store.configs.length ? store.configs[0].id : null;
  store.lastConfigId = currentId;
  persist();
  renderConfigSelect();
  selectConfig(currentId);
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function openSettings() {
  $('sCompose').value = store.settings.composeCmd || 'docker compose';
  $('sForceColor').checked = store.settings.forceColor !== false;
  $('sAutoCleanup').checked = store.settings.autoCleanup !== false;
  $('sAutoSave').checked = store.settings.autoSave !== false;
  $('settingsOverlay').classList.remove('hidden');
}
function closeSettings() { $('settingsOverlay').classList.add('hidden'); }

function handleUpdateStatus(info) {
  latestUpdate = info;
  const btn = $('btnUpdate');
  if (info.error) {
    if (info.manual) $('updateStatus').textContent = 'Update check failed: ' + info.error;
    return;
  }
  if (info.current) { appVersion = info.current; $('verText').textContent = 'Version ' + info.current; }
  if (info.newer) {
    btn.style.display = '';
    btn.textContent = '⬆ Update to v' + info.latest;
    $('updateStatus').textContent = 'Update available: v' + info.latest + '. Click to download the new version.';
  } else {
    btn.style.display = 'none';
    if (info.manual) $('updateStatus').textContent = "You're up to date (v" + info.current + ').';
  }
}
function saveSettings() {
  store.settings.composeCmd = $('sCompose').value.trim() || 'docker compose';
  store.settings.forceColor = $('sForceColor').checked;
  store.settings.autoCleanup = $('sAutoCleanup').checked;
  store.settings.autoSave = $('sAutoSave').checked;
  persist();
  closeSettings();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('btnRun').addEventListener('click', run);
  $('btnStop').addEventListener('click', stop);
  $('btnNew').addEventListener('click', () => openConfigEditor(null));
  $('btnEdit').addEventListener('click', () => openConfigEditor(currentConfig() ? currentId : null));
  $('btnDelete').addEventListener('click', deleteCurrent);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnClear').addEventListener('click', () => term.clear());

  $('configSelect').addEventListener('change', (e) => { if (e.target.value) selectConfig(e.target.value); });

  $('tgFiles').addEventListener('click', toggleFiles);
  $('tgEditor').addEventListener('click', toggleEditor);
  $('tgBrowser').addEventListener('click', toggleBrowser);
  $('tgTerminal').addEventListener('click', toggleTerminal);
  $('tgLayout').addEventListener('click', toggleLayout);

  $('btnOpenFolder').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (!folder) return;
    const cfg = currentConfig();
    if (cfg) { cfg.projectRoot = folder; persist(); }
    openProject(folder);
  });
  $('btnRefreshTree').addEventListener('click', () => { if (projectRoot) openProject(projectRoot); });
  $('btnSaveFile').addEventListener('click', saveActiveTab);

  $('navBack').addEventListener('click', () => { const w = activeWebview(); if (w && w.canGoBack()) w.goBack(); });
  $('navFwd').addEventListener('click', () => { const w = activeWebview(); if (w && w.canGoForward()) w.goForward(); });
  $('navReload').addEventListener('click', () => { const w = activeWebview(); if (w) w.reload(); });
  $('navHardReload').addEventListener('click', () => { const w = activeWebview(); if (w) w.reloadIgnoringCache(); });
  $('navGo').addEventListener('click', () => navigate($('urlInput').value));
  $('btnAddTab').addEventListener('click', () => { editorTabsWork.push({ name: '', url: '', isDefault: editorTabsWork.length === 0, session: 'shared' }); renderEditorTabs(); });
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate($('urlInput').value); });

  $('btnBrowse').addEventListener('click', async () => {
    const file = await window.api.openCompose();
    if (!file) return;
    $('fCompose').value = file;
    await parseServices(file, $('fService').value);
    refreshPreview();
  });
  $('btnRefresh').addEventListener('click', () => { const f = $('fCompose').value.trim(); if (f) parseServices(f, $('fService').value); });
  $('fService').addEventListener('change', () => { maybePrefillPorts(); refreshPreview(); });
  $('fContainerPort').addEventListener('input', () => {
    const p = $('fContainerPort').value.trim();
    const cmd = $('fCommand').value;
    if (p && /0\.0\.0\.0:\d+/.test(cmd)) $('fCommand').value = cmd.replace(/(0\.0\.0\.0:)\d+/, `$1${p}`);
    refreshPreview();
  });
  ['fCommand', 'fHostPort', 'fExtra', 'fCompose'].forEach((id) => $(id).addEventListener('input', refreshPreview));
  $('btnEditorCancel').addEventListener('click', closeConfigEditor);
  $('btnEditorSave').addEventListener('click', saveConfigEditor);

  $('btnSettingsCancel').addEventListener('click', closeSettings);
  $('btnSettingsSave').addEventListener('click', saveSettings);

  // Updates
  $('btnUpdate').addEventListener('click', () => {
    if (latestUpdate) window.api.openDownload(latestUpdate.dmgUrl || latestUpdate.url);
  });
  $('btnCheckUpdate').addEventListener('click', () => {
    $('updateStatus').textContent = 'Checking…';
    window.api.checkUpdate();
  });
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.appVersion().then((v) => { appVersion = v; $('verText').textContent = 'Version ' + v; });

  // Find dialog
  $('findClose').addEventListener('click', closeFind);
  $('findInput').addEventListener('input', runFind);
  $('findCase').addEventListener('change', doFind);
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (findItems.length) { findSel = (findSel + 1) % findItems.length; updateFindSelection(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (findItems.length) { findSel = (findSel - 1 + findItems.length) % findItems.length; updateFindSelection(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (findItems.length) openFindItem(findSel); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });

  // Shift-Shift to open Find
  let lastShift = 0;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !e.repeat) {
      const now = performance.now();
      if (now - lastShift < 400) { lastShift = 0; openFind(); }
      else lastShift = now;
    } else if (e.key !== 'Shift') {
      lastShift = 0;
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); saveActiveTab(); }
    else if (mod && e.key === 'r' && !e.shiftKey) { e.preventDefault(); if (!running) run(); }
    else if (e.key === 'Escape') { closeConfigEditor(); closeSettings(); }
  });

  // Autosave when the whole app loses focus (switching to another window/app).
  window.addEventListener('blur', () => { if (autoSaveOn()) saveAllDirty(); });
  window.addEventListener('beforeunload', saveAllDirty);

  // Process output
  window.api.onRunInfo((info) => {
    term.writeln(`\x1b[90m${info.line}\x1b[0m`);
    term.writeln(`\x1b[90m  (cwd: ${info.cwd})\x1b[0m`);
  });
  window.api.onRunData((data) => {
    term.write(data);
    // Servers announce when they're ready. Refresh every tab the FIRST time we
    // see it this run (so Django's hot-reload re-prints don't keep reloading).
    // Strip ANSI colours and match on a rolling buffer so colour codes or
    // chunk boundaries can't hide the phrase.
    if (!bootDetected) {
      bootBuf = (bootBuf + data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-4000);
      // Only the actual bind line — NOT "Watching for file changes", which the
      // autoreloader prints a couple of seconds before the server binds.
      if (/Listening on TCP|Starting development server at|Running on http|Uvicorn running on/i.test(bootBuf)) {
        bootDetected = true;
        term.writeln('\x1b[90m[sde] Server is up — refreshing browser tabs.\x1b[0m');
        setTimeout(reloadAllTabs, 500);
      }
    }
  });
  window.api.onRunExit((info) => {
    setRunning(false);
    clearInterval(bootTimer);
    bootTimer = null;
    const code = info.signal ? `signal ${info.signal}` : `exit code ${info.code}`;
    term.writeln(`\r\n\x1b[90m[sde] Process finished (${code}).\x1b[0m`);
    const s = $('status');
    s.textContent = 'stopped';
    s.className = 'status stopped';
  });

  makeVSplitter('vsplit', 'sidebar', 'left');
  makeVSplitter('hsplit', 'browserPane', 'right');
  makeHSplitter();
  window.addEventListener('resize', () => { safeFit(); editor.refresh(); });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  store = await window.api.loadStore();
  view();
  currentId = store.lastConfigId && store.configs.some((c) => c.id === store.lastConfigId)
    ? store.lastConfigId
    : (store.configs[0] ? store.configs[0].id : null);
  renderConfigSelect();
  wire();
  renderTabBar();
  applyView();
  if (currentId) selectConfig(currentId);
  else buildBrowserTabs(configBrowserTabs(null));
  term.writeln('\x1b[90mSimple Django Editor — pick or create a configuration, then press Run.\x1b[0m');
  term.writeln('\x1b[90mTip: double-tap Shift to search across all project files.\x1b[0m');
  if (!store.configs.length) term.writeln('\x1b[90mNo configurations yet — click “＋ New”.\x1b[0m');
}

init();
