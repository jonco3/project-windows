"use strict";

const STORAGE_KEY = "foxcub.projects";
const SCHEMA_KEY = "foxcub.schemaVersion";
const CURRENT_SCHEMA = 1;
// Sessions key used to tag a window as belonging to a project. The value is
// the project's UUID. Tags survive window close and Firefox restart via
// session restore, which lets us re-associate windows with projects on
// startup even though window IDs are not stable across restarts.
const WINDOW_TAG = "foxcub.projectId";

// Serialise all storage writes through a single promise chain so that
// concurrent events (rapid tab changes, close-then-restore, etc.) cannot
// interleave reads and writes of the projects array.
let saveQueue = Promise.resolve();
function withWrite(fn) {
  const result = saveQueue.then(fn);
  saveQueue = result.catch(() => {});
  return result;
}

async function loadProjects() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || [];
}

async function saveProjects(projects) {
  await browser.storage.local.set({ [STORAGE_KEY]: projects });
}

function snapshotTabs(tabs) {
  return tabs
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      url: t.url || t.pendingUrl || "about:blank",
      pinned: !!t.pinned,
    }));
}

// Coalesce repeated snapshot requests for the same windowId within a microtask.
const pendingSnapshots = new Map();
function scheduleSnapshot(windowId) {
  if (typeof windowId !== "number" || windowId < 0) return;
  if (pendingSnapshots.has(windowId)) return pendingSnapshots.get(windowId);

  const p = Promise.resolve().then(async () => {
    pendingSnapshots.delete(windowId);
    await withWrite(async () => {
      const projects = await loadProjects();
      const project = projects.find((x) => x.windowId === windowId);
      if (!project) return;
      let tabs;
      try {
        tabs = await browser.tabs.query({ windowId });
      } catch {
        return;
      }
      project.tabs = snapshotTabs(tabs);
      project.snapshotAt = Date.now();
      await saveProjects(projects);
    });
  });
  pendingSnapshots.set(windowId, p);
  return p;
}

async function createProject(name) {
  name = (name || "").trim();
  if (!name) throw new Error("name required");

  const win = await browser.windows.create({});
  const project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    windowId: win.id,
    tabs: [],
    snapshotAt: 0,
  };

  // Tag the window before persisting the windowId cache: if we crash between
  // these two steps, reconcile() will still recover the association from the
  // tag on the next startup.
  try {
    await browser.sessions.setWindowValue(win.id, WINDOW_TAG, project.id);
  } catch {}

  await withWrite(async () => {
    const projects = await loadProjects();
    projects.push(project);
    await saveProjects(projects);
  });

  scheduleSnapshot(win.id);
  return project;
}

async function listProjects() {
  return withWrite(async () => {
    const projects = await loadProjects();
    let dirty = false;
    for (const p of projects) {
      if (p.windowId !== null) {
        try {
          await browser.windows.get(p.windowId);
        } catch {
          p.windowId = null;
          dirty = true;
        }
      }
    }
    if (dirty) await saveProjects(projects);
    return projects;
  });
}

async function focusProject(id) {
  const projects = await loadProjects();
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error("not found");
  if (p.windowId === null) throw new Error("project is closed");
  await browser.windows.update(p.windowId, { focused: true });
  return { ok: true };
}

async function restoreProject(id) {
  return withWrite(async () => {
    const projects = await loadProjects();
    const project = projects.find((x) => x.id === id);
    if (!project) throw new Error("not found");

    if (project.windowId !== null) {
      try {
        await browser.windows.update(project.windowId, { focused: true });
        return project;
      } catch {
        project.windowId = null;
      }
    }

    const tabs =
      project.tabs.length > 0
        ? project.tabs
        : [{ url: "about:blank", pinned: false }];

    let win;
    try {
      win = await browser.windows.create({ url: tabs[0].url });
    } catch {
      win = await browser.windows.create({ url: "about:blank" });
    }
    try {
      await browser.sessions.setWindowValue(win.id, WINDOW_TAG, project.id);
    } catch {}
    project.windowId = win.id;
    await saveProjects(projects);

    const [firstTab] = await browser.tabs.query({ windowId: win.id });
    if (firstTab && tabs[0].pinned) {
      try {
        await browser.tabs.update(firstTab.id, { pinned: true });
      } catch {}
    }

    for (let i = 1; i < tabs.length; i++) {
      const t = tabs[i];
      try {
        await browser.tabs.create({
          windowId: win.id,
          url: t.url,
          pinned: t.pinned,
          active: false,
        });
      } catch {
        try {
          await browser.tabs.create({
            windowId: win.id,
            url: "about:blank",
            pinned: t.pinned,
            active: false,
          });
        } catch {}
      }
    }

    return project;
  });
}

async function renameProject(id, name) {
  name = (name || "").trim();
  if (!name) throw new Error("name required");
  await withWrite(async () => {
    const projects = await loadProjects();
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error("not found");
    p.name = name;
    await saveProjects(projects);
  });
  return { ok: true };
}

async function deleteProject(id) {
  await withWrite(async () => {
    const projects = await loadProjects();
    const i = projects.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("not found");
    if (projects[i].windowId !== null) {
      throw new Error("project is open; close it first");
    }
    projects.splice(i, 1);
    await saveProjects(projects);
  });
  return { ok: true };
}

browser.windows.onRemoved.addListener((wid) => {
  withWrite(async () => {
    const projects = await loadProjects();
    const p = projects.find((x) => x.windowId === wid);
    if (p) {
      p.windowId = null;
      await saveProjects(projects);
    }
  });
});

browser.tabs.onCreated.addListener((tab) => scheduleSnapshot(tab.windowId));

browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    changeInfo.url ||
    changeInfo.pinned !== undefined ||
    changeInfo.status === "complete"
  ) {
    scheduleSnapshot(tab.windowId);
  }
});

browser.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) return;
  scheduleSnapshot(removeInfo.windowId);
});

browser.tabs.onMoved.addListener((_tabId, moveInfo) =>
  scheduleSnapshot(moveInfo.windowId),
);

browser.tabs.onAttached.addListener((_tabId, attachInfo) =>
  scheduleSnapshot(attachInfo.newWindowId),
);

browser.tabs.onDetached.addListener((_tabId, detachInfo) =>
  scheduleSnapshot(detachInfo.oldWindowId),
);

// Walk all current windows, read their foxcub tag, and rebuild each
// project's windowId from those tags. Replaces the older "null everything on
// startup" approach. Session-restored windows that carry their tag get
// re-associated automatically.
async function reconcile() {
  return withWrite(async () => {
    const projects = await loadProjects();
    if (projects.length === 0) return;

    const windows = await browser.windows.getAll();
    const tagged = new Map(); // projectId -> windowId
    for (const w of windows) {
      let pid;
      try {
        pid = await browser.sessions.getWindowValue(w.id, WINDOW_TAG);
      } catch {
        continue;
      }
      if (pid && !tagged.has(pid)) tagged.set(pid, w.id);
    }

    let dirty = false;
    for (const p of projects) {
      const wid = tagged.has(p.id) ? tagged.get(p.id) : null;
      if (p.windowId !== wid) {
        p.windowId = wid;
        dirty = true;
      }
    }
    if (dirty) await saveProjects(projects);

    // Fire-and-forget fresh snapshot for each re-associated window.
    for (const p of projects) {
      if (p.windowId !== null) scheduleSnapshot(p.windowId);
    }
  });
}

browser.runtime.onStartup.addListener(reconcile);

// Catches windows that Firefox session-restores after the extension has
// already loaded (the onStartup reconcile may run before they appear).
browser.windows.onCreated.addListener(async (window) => {
  let pid;
  try {
    pid = await browser.sessions.getWindowValue(window.id, WINDOW_TAG);
  } catch {
    return;
  }
  if (!pid) return;

  await withWrite(async () => {
    const projects = await loadProjects();
    const p = projects.find((x) => x.id === pid);
    if (!p) return;
    if (p.windowId === window.id) return;
    p.windowId = window.id;
    await saveProjects(projects);
  });
  scheduleSnapshot(window.id);
});

browser.runtime.onInstalled.addListener(async () => {
  await withWrite(async () => {
    const stored = await browser.storage.local.get([STORAGE_KEY, SCHEMA_KEY]);
    const patch = {};
    if (!stored[STORAGE_KEY]) patch[STORAGE_KEY] = [];
    if (!stored[SCHEMA_KEY]) patch[SCHEMA_KEY] = CURRENT_SCHEMA;
    if (Object.keys(patch).length > 0) {
      await browser.storage.local.set(patch);
    }
  });
  await reconcile();
});

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "listProjects":
      return listProjects().then(
        (projects) => ({ projects }),
        (e) => ({ error: e.message }),
      );
    case "createProject":
      return createProject(msg.name).then(
        (project) => ({ project }),
        (e) => ({ error: e.message }),
      );
    case "focusProject":
      return focusProject(msg.id).catch((e) => ({ error: e.message }));
    case "restoreProject":
      return restoreProject(msg.id).then(
        (project) => ({ project }),
        (e) => ({ error: e.message }),
      );
    case "renameProject":
      return renameProject(msg.id, msg.name).catch((e) => ({
        error: e.message,
      }));
    case "deleteProject":
      return deleteProject(msg.id).catch((e) => ({ error: e.message }));
    default:
      return Promise.resolve({ error: "unknown message type" });
  }
});
