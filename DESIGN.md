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
- **Open / focus a project.** The popup shows all projects in two sections:
  *Open* (currently has a window) and *Closed* (window is gone, state saved).
  Clicking an Open row focuses that window; clicking a Closed row reopens it.
- **Close a project.** Just close the window. foxcub notices and moves the
  project from Open to Closed. The tabs at the moment of close are what get
  restored later.
- **Rename / delete.** Closed projects can be renamed or deleted from the popup.
  Open projects must be closed first before they can be deleted.

A project's identity is its `id` (a UUID), not its name, so two projects can
share the same name without confusion in storage.

## Architecture

Three pieces:

1. **`manifest.json`** — declares MV3, `tabs` + `storage` permissions, the
   background script, the action popup, and an SVG icon. No host permissions
   are needed (see *Permissions* below).
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
default new-tab page), records a `Project` with that window's `id`, and
triggers an initial snapshot.

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
2. Immediately persist `project.windowId = win.id` so a mid-restore background
   eviction still leaves the window associated.
3. If the first tab was pinned, `tabs.update(firstTab.id, {pinned: true})`.
4. For each remaining saved tab, **sequentially** await
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

Firefox does not guarantee that window IDs survive a browser restart. On
`runtime.onStartup`, foxcub walks every project and sets `windowId = null` —
treating all projects as Closed. The user reopens whichever projects they
want.

A consequence: if Firefox's session restore brings back the windows that were
open before shutdown, those windows are *not* re-associated with their
projects. Restoring a project from the popup will create a *new* window,
giving you a duplicate. This is a known quirk; see below.

As a defensive measure, every time the background services a message, it
also verifies each open project's `windowId` with `windows.get` and nulls out
any that have disappeared.

## Known quirks

- **Browser restart with projects open.** Session-restored windows become
  orphans; restoring a project creates a duplicate window. Future work: at
  startup, snapshot existing windows' URL multisets and try to match them
  against the last saved snapshots.
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

No host permissions (`<all_urls>`, etc.) are needed: foxcub never injects
content scripts, fetches page content, or reads anything from inside a page.
It only reads metadata exposed by the `tabs` and `windows` APIs and creates
or focuses windows and tabs.
