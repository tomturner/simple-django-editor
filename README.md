# Simple Django Editor

A tiny, cross-platform, IDE-style desktop app for running Django dev servers
**inside Docker Compose** — with a file tree, a code editor, a built-in Chromium
browser, and a live terminal, all in one window.

Built with Electron, so it's the same on macOS and Windows and it *is* Chromium
(the embedded browser comes for free).

## Features

- **Run configurations**: pick a `docker-compose` file, choose a
  service, set the command, and map a host/container port. Named configs are
  saved and restored between launches.
- **Runs the server the Docker way**:
  `docker compose -f <file> run --rm -p <host>:<container> <service> <command>`,
  with the exact command shown in a live preview.
- **Automatic housekeeping**: before each run it clears leftover one-off
  `*-run-*` containers and (optionally) stops a same-project container that's
  holding the host port, so you don't hit "port is already allocated".
- **Built-in browser** that points at your server and auto-retries while it
  boots. Full right-click menu (back/forward, reload, view source, inspect,
  DevTools) plus a hard-reload (⚡) button.
- **File explorer + code editor** (CodeMirror) with syntax highlighting for
  Python, JS/TS, HTML/templates, CSS, YAML, JSON, Markdown, shell and more.
  Files open as tabs; **autosave on focus-loss** (⌘S forces a save).
- **Find in Files**: double-tap **Shift** to search file contents and names
  across the whole project; Enter/click jumps to the line.
- **Flexible layout**: toggle the explorer, editor, browser and terminal
  independently, switch the editor/browser between **Split** and **Tabs**, and
  drag any divider to resize. Layout is remembered.

## Getting started

```bash
npm install
npm start
```

## Building a distributable

```bash
npm run dist:mac    # .dmg / .zip
npm run dist:win    # NSIS installer
```

## Notes

- Requires Docker (Compose v2 `docker compose`, or set v1 `docker-compose` in
  Settings).
- Django's auto-reload works as usual (it's Django's `runserver`, not the app)
  as long as your code is bind-mounted into the container and you don't pass
  `--noreload`.
- Saved run-configs live in your OS app-data directory, not in the project.

## License

MIT
