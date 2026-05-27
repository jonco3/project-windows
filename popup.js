"use strict";

const projectList = document.getElementById("project-list");
const listEmpty = document.getElementById("list-empty");
const errorEl = document.getElementById("error");
const newForm = document.getElementById("new-form");
const newName = document.getElementById("new-name");

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = !text;
}

function makeRow(project, currentWindowId) {
  const open = project.windowId !== null;
  const current = open && project.windowId === currentWindowId;

  const li = document.createElement("li");
  li.dataset.id = project.id;
  li.classList.add(open ? "is-open" : "is-closed");
  if (current) li.classList.add("is-current");

  const status = document.createElement("span");
  status.className = "status";
  status.textContent = open ? "●" : "○";
  status.title = open ? "Open" : "Closed";
  li.appendChild(status);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = project.name;
  li.appendChild(name);

  const count = document.createElement("span");
  count.className = "count";
  const n = project.tabs ? project.tabs.length : 0;
  count.textContent = n === 1 ? "1 tab" : `${n} tabs`;
  li.appendChild(count);

  const actions = document.createElement("span");
  actions.className = "actions";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.textContent = "rename";
  renameBtn.title = "Rename project";
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onRename(project);
  });
  actions.appendChild(renameBtn);

  if (!open) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "delete";
    deleteBtn.title = "Delete project";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete(project);
    });
    actions.appendChild(deleteBtn);
  }

  li.appendChild(actions);

  li.addEventListener("click", () =>
    open ? onFocus(project) : onRestore(project),
  );

  return li;
}

function render(projects, currentWindowId) {
  projectList.replaceChildren();

  const sorted = projects
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  for (const p of sorted) projectList.appendChild(makeRow(p, currentWindowId));

  listEmpty.hidden = sorted.length > 0;
}

async function refresh() {
  showError("");
  const [resp, currentWin] = await Promise.all([
    send({ type: "listProjects" }),
    browser.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .catch(() => null),
  ]);
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  render(resp.projects || [], currentWin ? currentWin.id : null);
}

async function onFocus(project) {
  const resp = await send({ type: "focusProject", id: project.id });
  if (resp && resp.error) {
    showError(resp.error);
    refresh();
    return;
  }
  window.close();
}

async function onRestore(project) {
  const resp = await send({ type: "restoreProject", id: project.id });
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  window.close();
}

async function onRename(project) {
  const name = prompt("Rename project", project.name);
  if (name === null) return;
  const resp = await send({ type: "renameProject", id: project.id, name });
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  refresh();
}

async function onDelete(project) {
  const resp = await send({ type: "deleteProject", id: project.id });
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  refresh();
}

newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = newName.value.trim();
  if (!name) return;
  const resp = await send({ type: "createProject", name });
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  newName.value = "";
  window.close();
});

document.addEventListener("DOMContentLoaded", refresh);
if (document.readyState !== "loading") refresh();
