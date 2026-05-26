Project Windows
===============

A Firefox extension that organises browsing into named **project windows**.
A project is a browser window with a name; its tabs are saved as you go, so
you can close the window and reopen it later with the same tabs in the same
order.

## What it does

- **Create a project.** Click the toolbar button, type a name, hit Enter.
  A new window opens, tagged as that project.
- **Switch between projects.** The popup lists every project. A filled dot
  means the window is open; an empty dot means it is closed. Click an open
  row to focus its window, or a closed row to reopen it with its saved tabs.
- **Close a project.** Just close the window. The tabs at the moment of
  close are what get restored next time.
- **Rename or delete.** Rename any project from the popup. Delete is only
  available on closed projects.

Projects survive browser restarts: Firefox's session restore brings tagged
windows back, and the extension re-associates them on startup.

## Install (for development)

1. Open `about:debugging` in Firefox.
2. Choose *This Firefox* → *Load Temporary Add-on…*.
3. Pick `manifest.json` from this directory.

Requires Firefox 140 or newer (Manifest V3).

## Permissions

Only `tabs`, `storage`, and `sessions`. No host permissions: the extension
never reads page content, only tab metadata.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — event-page background; owns all storage and lifecycle
- `popup.html` / `popup.js` / `popup.css` — toolbar popup UI
- `icons/` — toolbar icon
- `DESIGN.md` — architecture, data model, and lifecycle details
