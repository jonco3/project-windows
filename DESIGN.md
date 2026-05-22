foxcub — Design
===============

## Overview

foxcub is a Firefox WebExtension (Manifest V3) that lets you organise your
browsing into named **project windows**. A project is a window with a name; its
list of tabs is persisted whenever it changes. When you close a project's
window, the saved tab state remains so you can reopen the window later with the
same tabs (same URLs, same order, same pinned status).

The extension is intentionally small: a single background event page handles
state, and a toolbar popup provides the UI. There are no servers, no sync, and
no UI surfaces other than the popup.

## User model

- **Create a project.** Click the foxcub toolbar button, type a name, hit
  Enter. A new browser window opens; it is now a project window.
- **Open / focus a project.** The popup shows a single alphabetical list of
  all projects. Each row carries a small status indicator: a filled dot for
  projects whose window is currently open, an empty dot for closed ones.
  Clicking an open row focuses its window; clicking a closed row reopens it.
- **Close a project.** Just close the window. foxcub notices and the row's
  status indicator flips to "closed" on next popup open. The tabs at the
  moment of close are what get restored later.
- **Rename / delete.** Any project can be renamed from the popup. Delete is
  only available on closed projects; open ones must be closed first.

A project's identity is its `id` (a UUID), not its name, so two projects can
share the same name without confusion in storage.

## Architecture

Three pieces:

1. **`manifest.json`** — declares MV3, `tabs` + `storage` + `sessions`
   permissions, the background script, the action popup, and an SVG icon. No
   host permissions are needed (see *Permissions* below).
2. **`background.js`** — the event-page background. Owns all storage I/O,
   listens to window/tab lifecycle events, and serves the popup over
   `runtime.onMessage`.
3. **`popup.html` / `popup.js` / `popup.css`** — the toolbar popup. Renders the
   project list and dispatches actions to the background. It never touches
   `storage.local` directly; the background is the single writer.

Message contract (all over `browser.runtime.sendMessage`):

| Request                                          | Response                       |
| ------------------------------------------------ | ------------------------------ |
| `{type:'listProjects'}`                          | `{projects}` or `{error}`      |
| `{type:'createProject', name}`                   | `{project}` or `{error}`       |
| `{type:'focusProject', id}`                      | `{ok:true}` or `{error}`       |
| `{type:'restoreProject', id}`                    | `{project}` or `{error}`       |
| `{type:'renameProject', id, name}`               | `{ok:true}` or `{error}`       |
| `{type:'deleteProject', id}`                     | `{ok:true}` or `{error}`       |

## Data model

A single key in `browser.storage.local`:

- `"foxcub.projects"` — array of `Project`, in display order
- `"foxcub.schemaVersion"` — integer, currently `1`

```
Project {
  id:         string   // crypto.randomUUID()
  name:       string   // user-supplied, trimmed
  createdAt:  number
  windowId:   number | null   // current window id, or null when closed
  tabs:       TabSnapshot[]   // last known snapshot
  snapshotAt: number
}

TabSnapshot {
  url:    string
  pinned: boolean
  // tab order is implicit from array order
}
```

All storage writes go through a single in-memory promise chain (`saveQueue`)
so concurrent events cannot interleave read-modify-write cycles.

## Lifecycle

**Create.** `createProject({name})` opens a new window with no URL (Firefox's
default new-tab page), tags the window with the project's UUID via
`browser.sessions.setWindowValue(windowId, "foxcub.projectId", id)`, records
a `Project` with that window's `id`, and triggers an initial snapshot. The
session-API tag is the source of truth for window-to-project association;
the `windowId` in storage is just a cache for fast lookup in event handlers.

**Maintain the snapshot.** While a project window is open, the background
listens to:

- `tabs.onCreated`
- `tabs.onUpdated` (filtered to URL / pinned / load-complete changes)
- `tabs.onRemoved` (skipped when `removeInfo.isWindowClosing` — the window is
  about to vanish, the snapshot is already authoritative)
- `tabs.onMoved`
- `tabs.onAttached` (tab moved *into* this window — refresh destination)
- `tabs.onDetached` (tab moved *out* — refresh source)

Any matching event schedules a snapshot refresh for the affected window. A
per-window microtask coalescer collapses bursts of events to one
`tabs.query({windowId})` call. The query result is sorted by `index`, mapped
to `TabSnapshot`s, and saved.

**Close.** `windows.onRemoved(wid)` finds the project with that `windowId` and
sets `windowId = null`. The snapshot is **not** re-captured at close time —
tabs are already gone from the API. The maintenance listeners above ensure
the saved snapshot was already current.

**Restore.** See next section.

## Restore mechanics

Given a project with `tabs = [{url, pinned}, ...]`:

1. `browser.windows.create({url: tabs[0].url})` — creates a window with
   exactly one tab seeded to the first saved URL.
2. Tag the new window with `sessions.setWindowValue(win.id,
   "foxcub.projectId", project.id)` so it survives close/restart.
3. Persist `project.windowId = win.id` so a mid-restore background eviction
   still leaves the window associated.
4. If the first tab was pinned, `tabs.update(firstTab.id, {pinned: true})`.
5. For each remaining saved tab, **sequentially** await
   `tabs.create({windowId, url, pinned, active: false})`. Sequential, not
   `Promise.all`, so the new tabs land in the saved order.

If any `tabs.create` rejects (e.g. a privileged URL like `about:addons`,
`view-source:`, `file://...`), foxcub substitutes `about:blank` so one bad
URL never aborts a restore.

The same code path also handles "restore an already-open project": if the
project's `windowId` is non-null and the window still exists, foxcub just
focuses it; if the window is missing (i.e. the record is stale), it falls
through to the restore path.

## Startup reconciliation

Firefox does not guarantee that window IDs survive a browser restart, but
data written via `sessions.setWindowValue` does — Firefox's own session
restore carries it along when it restores a window. foxcub uses that to
rebuild the project ↔ window mapping after a restart.

On `runtime.onStartup` (and `runtime.onInstalled`, which fires on
reload-during-development), foxcub calls `reconcile()`:

1. `windows.getAll()` → for each current window, read
   `sessions.getWindowValue(windowId, "foxcub.projectId")`.
2. Build a `projectId → windowId` map from the tags found.
3. For each project, update its cached `windowId` to whatever the map says
   (or `null` if no window carries its tag).
4. Trigger a fresh tab snapshot for each re-associated window so the saved
   state matches reality (the user may have changed tabs while foxcub was
   not running).

A second listener on `windows.onCreated` catches the case where Firefox
restores a tagged window *after* the extension has already finished
`onStartup` — it reads the tag, associates the project, and snapshots.

The defensive `windows.get` check on every `listProjects` call remains: it
nulls out any cached `windowId` whose window no longer exists, which
protects against drift from events the background may have missed while
unloaded.

## Known quirks

- **Browser restart with projects open.** Tagged windows that Firefox
  session-restores are re-associated automatically via the sessions API. If
  the user has disabled session restore, or clears their session/history
  data, the tag is lost and the affected projects appear as Closed on next
  startup — restoring them then creates fresh windows.
- **Private windows.** Out of scope for v1. Restored windows are always
  non-private regardless of the original.
- **Privileged URLs.** `about:*`, `view-source:`, `file://*`, and similar
  cannot be opened by extensions. Restore replaces them with `about:blank`.
- **Project name collisions.** Allowed. Names are for display only; identity
  is the UUID.
- **Race: rapid close-then-restore.** Serialised through the single
  `saveQueue` chain — no interleaved writes.

## Permissions

`manifest.json` requests only:

- `tabs` — required to read `tab.url` reliably for non-extension origins.
- `storage` — for `browser.storage.local`.
- `sessions` — for `setWindowValue` / `getWindowValue`, which tag windows
  with their project UUID so that session-restored windows can be
  re-associated after a browser restart.

No host permissions (`<all_urls>`, etc.) are needed: foxcub never injects
content scripts, fetches page content, or reads anything from inside a page.
It only reads metadata exposed by the `tabs` and `windows` APIs and creates
or focuses windows and tabs.
