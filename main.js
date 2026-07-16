'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const yaml = require('js-yaml');

const UPDATE_REPO = 'tomturner/simple-django-editor';

// Apps launched from Finder/Dock inherit a minimal PATH that usually omits the
// locations where `docker` lives, so spawning it would fail with ENOENT. Make
// sure the common CLI bin dirs are on PATH (harmless in dev, essential when packaged).
if (process.platform !== 'win32') {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  process.env.PATH = Array.from(new Set(current.concat(extra))).join(':');
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'simple-django-editor.json');
}

const DEFAULT_STORE = {
  settings: {
    // Split so we can support both `docker compose` (v2) and `docker-compose` (v1).
    composeCmd: 'docker compose',
    forceColor: true,
    // Remove leftover one-off `... -run-<hash>` containers before each run.
    // This frees the host port and clears Compose's "orphan containers" warning.
    autoCleanup: true,
    // Claude Code commands the user can run in the terminal window. Edit in Settings.
    claudeCommands: [
      { name: 'Claude', command: 'claude', isDefault: true },
      { name: 'Codex', command: 'codex' }
    ]
  },
  configs: [],
  lastConfigId: null
};

function loadStore() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      settings: Object.assign({}, DEFAULT_STORE.settings, parsed.settings),
      configs: Array.isArray(parsed.configs) ? parsed.configs : [],
      lastConfigId: parsed.lastConfigId || null
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
}

function saveStore(store) {
  fs.writeFileSync(configPath(), JSON.stringify(store, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

// Split a command string into argv, respecting single/double quotes.
function tokenize(str) {
  const tokens = [];
  let current = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) {
        tokens.push(current);
        current = '';
        has = false;
      }
    } else {
      current += ch;
      has = true;
    }
  }
  if (has) tokens.push(current);
  return tokens;
}

// Build [executable, args[]] for a run configuration.
function buildCommand(config, settings) {
  const composeParts = tokenize(settings.composeCmd || 'docker compose');
  const exe = composeParts[0];
  const args = composeParts.slice(1);

  args.push('-f', config.composeFile);
  args.push('run', '--rm');

  if (config.hostPort && config.containerPort) {
    args.push('-p', `${config.hostPort}:${config.containerPort}`);
  }

  // Extra docker-compose-run flags (advanced), e.g. -e FOO=bar or --build.
  if (config.extraArgs && config.extraArgs.trim()) {
    for (const t of tokenize(config.extraArgs)) args.push(t);
  }

  args.push(config.service);

  for (const t of tokenize(config.command || '')) args.push(t);

  return { exe, args };
}

// ---------------------------------------------------------------------------
// Cleanup of leftover one-off `docker compose run` containers
// ---------------------------------------------------------------------------

// Run a command and collect its output (used for docker housekeeping).
function execCollect(exe, cmdArgs, cwd) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try {
      p = spawn(exe, cmdArgs, { cwd });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
      return;
    }
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function sanitizeProject(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// Best-effort detection of the Compose project name, matching Compose's own rules:
// COMPOSE_PROJECT_NAME > top-level `name:` in the file > sanitized parent dir name.
function detectProject(config) {
  if (process.env.COMPOSE_PROJECT_NAME) return sanitizeProject(process.env.COMPOSE_PROJECT_NAME);
  try {
    const doc = yaml.load(fs.readFileSync(config.composeFile, 'utf8')) || {};
    if (doc.name) return sanitizeProject(doc.name);
  } catch (e) { /* fall through */ }
  return sanitizeProject(path.basename(path.dirname(config.composeFile)));
}

// Remove leftover one-off run containers for this project (names like
// "<project>-<service>-run-<hash>"). Force-removes even if still running,
// which is what frees a held host port.
async function cleanupOneoff(project, cwd) {
  const list = await execCollect('docker', [
    'ps', '-a',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--format', '{{.ID}}\t{{.Names}}'
  ], cwd);
  if (list.code !== 0) return { removed: 0, error: list.err.trim() };

  const ids = list.out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts[1] && /-run-[0-9a-f]{6,}$/.test(parts[1].trim()))
    .map((parts) => parts[0].trim())
    .filter(Boolean);

  if (!ids.length) return { removed: 0 };
  await execCollect('docker', ['rm', '-f', ...ids], cwd);
  return { removed: ids.length };
}

// If a running container is publishing `hostPort`, stop the ones that belong to
// the same Compose project (so the dev server can take the port over). Containers
// from other projects are reported but not touched.
async function freeHostPort(project, hostPort, cwd) {
  if (!hostPort) return { stopped: [], others: [] };
  const res = await execCollect('docker', [
    'ps',
    '--format', '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'
  ], cwd);
  if (res.code !== 0) return { stopped: [], others: [], error: res.err.trim() };

  const needle = `:${hostPort}->`; // matches "0.0.0.0:8080->" / "[::]:8080->"
  const sameProject = [];
  const others = [];
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [id, name, ports, proj] = line.split('\t');
    if (!ports || !ports.includes(needle)) continue;
    if (project && proj === project) sameProject.push({ id, name });
    else others.push({ id, name });
  }

  for (const c of sameProject) {
    await execCollect('docker', ['stop', c.id], cwd);
  }
  return { stopped: sameProject, others };
}

// ---------------------------------------------------------------------------
// Window + process
// ---------------------------------------------------------------------------
let mainWindow = null;
let child = null; // currently running docker process

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#1e1f22',
    title: 'Simple Django Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Claude Code — an interactive PTY terminal embedded in the main window. Runs
// the chosen command (e.g. `claude`) in the project folder via a login shell so
// the user's full PATH (including ~/.local/bin) is available.
// ---------------------------------------------------------------------------
let ccPty = null;
function killCcPty() { if (ccPty) { try { ccPty.kill(); } catch (e) { /* ignore */ } ccPty = null; } }

ipcMain.handle('cc:start', (_e, opts) => {
  opts = opts || {};
  killCcPty();
  let pty;
  try { pty = require('node-pty'); } catch (e) { send('cc:data', '\r\n[sde] Could not load terminal backend: ' + e.message + '\r\n'); return { ok: false }; }
  const shell = process.env.SHELL || '/bin/zsh';
  const root = opts.projectRoot;
  const cwd = (root && fs.existsSync(root)) ? root : (process.env.HOME || process.cwd());
  const env = Object.assign({}, process.env, { TERM: 'xterm-256color' });
  try {
    ccPty = pty.spawn(shell, ['-l', '-i'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd, env });
  } catch (e) {
    send('cc:data', '\r\n[sde] Failed to start shell: ' + e.message + '\r\n');
    return { ok: false };
  }
  ccPty.onData((d) => send('cc:data', d));
  ccPty.onExit((ev) => { send('cc:exit', { code: ev && ev.exitCode }); ccPty = null; });
  const cmd = (opts.command || '').trim();
  if (cmd) setTimeout(() => { if (ccPty) ccPty.write(cmd + '\r'); }, 500);
  return { ok: true, cwd };
});
ipcMain.on('cc:input', (_e, data) => { if (ccPty) ccPty.write(data); });
ipcMain.on('cc:resize', (_e, size) => { if (ccPty && size) { try { ccPty.resize(size.cols, size.rows); } catch (e) { /* ignore */ } } });
ipcMain.handle('cc:stop', () => { killCcPty(); return true; });

function stopChild(signal) {
  if (!child) return;
  try {
    child.kill(signal || 'SIGINT');
  } catch (err) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('store:load', () => loadStore());

ipcMain.handle('store:save', (_e, store) => {
  saveStore(store);
  return true;
});

ipcMain.handle('dialog:openCompose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a Docker Compose file',
    properties: ['openFile'],
    filters: [
      { name: 'Compose files', extensions: ['yml', 'yaml'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Parse a compose file and return the list of services (plus any port hints).
ipcMain.handle('compose:parse', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = yaml.load(raw) || {};
    const services = doc.services || {};
    const list = Object.keys(services).map((name) => {
      const svc = services[name] || {};
      const ports = Array.isArray(svc.ports) ? svc.ports.map(String) : [];
      return { name, ports };
    });
    return { ok: true, services: list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// File tree + editor
// ---------------------------------------------------------------------------
const MAX_EDIT_BYTES = 5 * 1024 * 1024;

ipcMain.handle('project:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Noise we never want to show in the file tree.
const TREE_HIDE_DIRS = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache'
]);
function isTreeHidden(name, isDir) {
  if (isDir) return TREE_HIDE_DIRS.has(name);
  return /\.(pyc|pyo)$/i.test(name) || name === '.DS_Store';
}

ipcMain.handle('fs:readdir', (_e, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const list = entries
      .filter((d) => !isTreeHidden(d.name, d.isDirectory()))
      .map((d) => ({
        name: d.name,
        path: path.join(dirPath, d.name),
        isDir: d.isDirectory()
      }));
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries: list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:readFile', (_e, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_EDIT_BYTES) return { ok: false, error: 'File is too large to open in the editor.' };
    const buf = fs.readFileSync(filePath);
    if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: 'This looks like a binary file.' };
    return { ok: true, content: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:writeFile', (_e, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Project-wide search (powers the Shift-Shift "Find in Files" dialog)
// ---------------------------------------------------------------------------
const SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', 'env', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', '.idea', '.vscode',
  '.next', '.cache', '.tox', 'coverage', 'staticfiles', 'site-packages'
]);
const SEARCH_MAX_FILE = 1024 * 1024;   // skip files bigger than 1 MB
const SEARCH_MAX_RESULTS = 1000;
const SEARCH_MAX_FILES = 20000;

ipcMain.handle('project:search', (_e, { root, query, caseSensitive }) => {
  if (!root || !query) return { ok: true, files: [], matches: [], truncated: false };
  const needle = caseSensitive ? query : query.toLowerCase();
  const files = [];    // filename matches: { path, rel }
  const matches = [];  // content matches:  { path, rel, lineNumber, line, col }
  let scanned = 0;
  let truncated = false;

  function walk(dir) {
    if (matches.length >= SEARCH_MAX_RESULTS || scanned >= SEARCH_MAX_FILES) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of entries) {
      if (matches.length >= SEARCH_MAX_RESULTS || scanned >= SEARCH_MAX_FILES) { truncated = true; return; }
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(d.name)) walk(full);
        continue;
      }
      if (!d.isFile()) continue;

      const rel = path.relative(root, full);
      const name = caseSensitive ? d.name : d.name.toLowerCase();
      if (name.includes(needle) && files.length < 200) files.push({ path: full, rel });

      scanned++;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.size > SEARCH_MAX_FILE) continue;
      let buf;
      try { buf = fs.readFileSync(full); } catch (e) { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary

      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        const col = hay.indexOf(needle);
        if (col !== -1) {
          matches.push({ path: full, rel, lineNumber: i + 1, line: lines[i].slice(0, 400), col });
          if (matches.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        }
      }
    }
  }
  walk(root);
  return { ok: true, files, matches, truncated };
});

ipcMain.handle('run:start', async (_e, { config, settings }) => {
  if (child) return { ok: false, error: 'A process is already running.' };

  let exe, args;
  try {
    ({ exe, args } = buildCommand(config, settings));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const cwd = config.composeFile ? path.dirname(config.composeFile) : process.cwd();
  const env = Object.assign({}, process.env);
  if (settings.forceColor) {
    env.FORCE_COLOR = '1';
    env.PYTHONUNBUFFERED = '1';
  }

  // Clear out stale one-off run containers so a held port is freed and Compose
  // does not complain about orphans.
  if (settings.autoCleanup !== false) {
    const project = detectProject(config);
    try {
      const r = await cleanupOneoff(project, cwd);
      if (r.removed) {
        send('run:data', `\x1b[90m[sde] Removed ${r.removed} leftover run container(s) for "${project}".\x1b[0m\r\n`);
      }
    } catch (e) {
      send('run:data', `\x1b[33m[sde] Cleanup skipped: ${e.message}\x1b[0m\r\n`);
    }

    // Take over the host port if a same-project container is holding it.
    if (config.hostPort) {
      try {
        const h = await freeHostPort(project, config.hostPort, cwd);
        if (h.stopped.length) {
          const names = h.stopped.map((c) => c.name).join(', ');
          send('run:data', `\x1b[90m[sde] Stopped ${names} to free port ${config.hostPort} (bring it back later with 'docker compose up').\x1b[0m\r\n`);
        }
        if (h.others.length) {
          const names = h.others.map((c) => c.name).join(', ');
          send('run:data', `\x1b[33m[sde] Port ${config.hostPort} is also held by ${names} from another project — not stopping that automatically. Stop it yourself or choose a different host port.\x1b[0m\r\n`);
        }
      } catch (e) {
        send('run:data', `\x1b[33m[sde] Port check skipped: ${e.message}\x1b[0m\r\n`);
      }
    }
  }

  send('run:info', { line: `$ ${exe} ${args.join(' ')}`, cwd });

  try {
    child = spawn(exe, args, { cwd, env });
  } catch (err) {
    child = null;
    return { ok: false, error: err.message };
  }

  const onData = (d) => {
    const text = d.toString();
    send('run:data', text);
    if (/port is already allocated|address already in use/i.test(text)) {
      send('run:data',
        '\x1b[33m[sde] That host port is already in use. Another container or process is holding it — ' +
        'try Stop then Run again (cleanup will free stale run containers), or pick a different host port in the config.\x1b[0m\r\n');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    send('run:data', `\r\n[sde] Failed to start process: ${err.message}\r\n`);
  });

  child.on('close', (code, signal) => {
    child = null;
    send('run:exit', { code, signal });
  });

  return { ok: true, pid: child.pid };
});

ipcMain.handle('run:stop', () => {
  stopChild('SIGINT');
  // Escalate if it does not exit promptly.
  setTimeout(() => stopChild('SIGTERM'), 4000);
  return true;
});

ipcMain.on('term:input', (_e, data) => {
  if (child && child.stdin && child.stdin.writable) {
    child.stdin.write(data);
  }
});

// ---------------------------------------------------------------------------
// Chrome-style right-click menu for the embedded browser (webview)
// ---------------------------------------------------------------------------
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  // navigationHistory is the modern API; fall back to the older methods.
  const nav = contents.navigationHistory;
  const canBack = () => (nav && nav.canGoBack ? nav.canGoBack() : contents.canGoBack());
  const canFwd = () => (nav && nav.canGoForward ? nav.canGoForward() : contents.canGoForward());
  const goBack = () => (nav && nav.goBack ? nav.goBack() : contents.goBack());
  const goFwd = () => (nav && nav.goForward ? nav.goForward() : contents.goForward());

  contents.on('context-menu', (_e, params) => {
    const ef = params.editFlags || {};
    const isImage = params.mediaType === 'image';
    const template = [];

    template.push(
      { label: 'Back', enabled: canBack(), click: goBack },
      { label: 'Forward', enabled: canFwd(), click: goFwd },
      { label: 'Reload', click: () => contents.reload() },
      { label: 'Hard Reload (ignore cache)', click: () => contents.reloadIgnoringCache() },
      { type: 'separator' }
    );

    if (params.linkURL) {
      template.push(
        { label: 'Open Link in Default Browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }

    if (isImage && params.srcURL) {
      template.push(
        { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }

    if (params.isEditable) {
      template.push(
        { label: 'Cut', enabled: ef.canCut, click: () => contents.cut() },
        { label: 'Copy', enabled: ef.canCopy, click: () => contents.copy() },
        { label: 'Paste', enabled: ef.canPaste, click: () => contents.paste() },
        { label: 'Select All', click: () => contents.selectAll() },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      template.push(
        { label: 'Copy', click: () => contents.copy() },
        { type: 'separator' }
      );
    }

    template.push(
      { label: 'View Page Source', click: () => openViewSource(contents.getURL()) },
      { label: 'Open in Default Browser', click: () => shell.openExternal(contents.getURL()) },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) }
    );

    Menu.buildFromTemplate(template).popup({ window: mainWindow || undefined });
  });
});

function openViewSource(url) {
  if (!url || url === 'about:blank') return;
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: `Source of ${url}`,
    backgroundColor: '#1e1f22'
  });
  win.loadURL('view-source:' + url);
}

// ---------------------------------------------------------------------------
// Update check (GitHub Releases). Notify-and-download — a silent in-place
// install would require an Apple-signed app.
// ---------------------------------------------------------------------------
function fetchJSON(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'simple-django-editor', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(fetchJSON(res.headers.location, redirects + 1));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timed out')));
  });
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdate(manual) {
  try {
    const rel = await fetchJSON(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    const dmg = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name));
    const info = {
      current,
      latest,
      newer: !!latest && compareVersions(latest, current) > 0,
      url: rel.html_url,
      dmgUrl: dmg && dmg.browser_download_url,
      manual: !!manual
    };
    send('update:status', info);
    return info;
  } catch (e) {
    const info = { error: e.message, manual: !!manual, current: app.getVersion() };
    send('update:status', info);
    return info;
  }
}

ipcMain.handle('update:check', () => checkForUpdate(true));
ipcMain.handle('update:open', (_e, url) => { if (url) shell.openExternal(url); return true; });
ipcMain.handle('app:version', () => app.getVersion());

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  setTimeout(() => checkForUpdate(false), 3500); // quiet check shortly after launch
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopChild('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { stopChild('SIGTERM'); killCcPty(); });
