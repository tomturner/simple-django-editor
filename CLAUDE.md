# CLAUDE.md

Guidance for working in this repo.

## What this is

**Simple Django Editor** — a small cross-platform Electron desktop app (macOS +
Windows) for running Django dev servers inside Docker Compose, with a file tree,
a code editor, an embedded multi-tab Chromium browser, and a live terminal.
PyCharm-style run configurations, but focused on the "run it in Docker" workflow.

## Run / develop

```bash
npm install
npm start            # launches Electron
```

No bundler/build step for the app code. The renderer loads its libraries
(`@xterm/xterm`, `@xterm/addon-fit`, `codemirror`) via **relative
`../node_modules/...` paths** in `renderer/index.html`. Because of this, `asar`
packaging is **disabled** (`build.asar: false` in package.json) so those paths
resolve in the packaged app too.

## Build / release

```bash
npm run dist:mac                          # or: npx electron-builder --mac --universal
```

Output goes to `dist/` (gitignored). Releases are automated: publishing a
GitHub Release triggers `.github/workflows/release.yml`, which builds the
universal macOS `.dmg` + `.zip` and attaches them (build uses
`--publish never`; assets are attached with the `gh` CLI). Bump `version` in
package.json before releasing — installer filenames use it. The app is **not
code-signed** (no Apple cert); first launch needs right-click → Open.

## Layout

- `main.js` — main process: window, IPC (docker spawn + streaming, compose
  parsing via `js-yaml`, filesystem read/write, project search), the webview
  right-click menu, container cleanup / host-port takeover before a run, and a
  **PATH fix** (prepends `/usr/local/bin`, `/opt/homebrew/bin`, … so a
  Finder-launched app can find `docker`).
- `preload.js` — contextBridge API exposed to the renderer as `window.api`.
- `renderer/` — `index.html`, `renderer.js` (all UI logic), `styles.css`.
- `test/wv/` — standalone Electron harnesses that reproduce webview
  load/warmup behavior (`electron test/wv/flow.js`). Not wired into `npm test`.

Run configurations and settings are persisted in the OS userData dir
(`app.getPath('userData')/simple-django-editor.json`), not in the repo.

## Embedded browser — important gotchas (hard-won)

The multi-tab browser uses one `<webview>` per tab. Key rules that took real
debugging to get right — don't regress these:

- **Build tab webviews when a config is selected, navigate them on Run.**
  Creating a webview and setting its URL in the *same tick* silently fails to
  load — the guest must be attached first.
- **Navigate with `loadURL`, not an `about:blank` src nudge.** The nudge
  aborts/re-requests fast enough that some servers reset the connection
  (ERR_CONNECTION_RESET), which caused a reload loop.
- **A tab is "loaded" only when it returns REAL content.** On Run the server is
  often still booting, so:
  - `did-fail-load` (connection refused) → Chromium shows an *error page*; a
    `did-finish-load` fires for it. Ignore it (track `failedLoad`).
  - The server can bind the port but return an **empty body during warmup**;
    check the document actually has content before marking the tab loaded.
  - Otherwise show a local "waiting" splash and keep retrying until real
    content arrives. Once a tab has real content, never auto-reload it.
- **Refresh once on the server's bind line** (`Listening on TCP` /
  `Starting development server at` / `Running on http`), NOT on Django's
  `Watching for file changes` (that prints ~2s before the port binds).
- Dragging a splitter over a webview needs a full-window drag overlay, or the
  webview swallows the mouseup and the drag never ends.

## Conventions

- Plain ES5/ES2017 JS, no framework, no TypeScript. Match the existing style.
- Commit only when asked. Keep `dist/` and `node_modules/` out of git.
