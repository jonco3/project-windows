"use strict";

const openList = document.getElementById("open-list");
const closedList = document.getElementById("closed-list");
const openEmpty = document.getElementById("open-empty");
const closedEmpty = document.getElementById("closed-empty");
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

function makeRow(project, kind) {
  const li = document.createElement("li");
  li.dataset.id = project.id;

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = project.name;
  li.appendChild(name);

  const count = document.createElement("span");
  count.className = "count";
  const n = project.tabs ? project.tabs.length : 0;
  count.textContent = n === 1 ? "1 tab" : `${n} tabs`;
  li.appendChild(count);

  if (kind === "closed") {
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

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "delete";
    deleteBtn.title = "Delete project";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete(project);
    });
    actions.appendChild(deleteBtn);

    li.appendChild(actions);

    li.addEventListener("click", () => onRestore(project));
  } else {
    li.addEventListener("click", () => onFocus(project));
  }

  return li;
}

function render(projects) {
  openList.replaceChildren();
  closedList.replaceChildren();

  const open = projects.filter((p) => p.windowId !== null);
  const closed = projects.filter((p) => p.windowId === null);

  for (const p of open) openList.appendChild(makeRow(p, "open"));
  for (const p of closed) closedList.appendChild(makeRow(p, "closed"));

  openEmpty.hidden = open.length > 0;
  closedEmpty.hidden = closed.length > 0;
}

async function refresh() {
  showError("");
  const resp = await send({ type: "listProjects" });
  if (resp && resp.error) {
    showError(resp.error);
    return;
  }
  render(resp.projects || []);
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
  if (!confirm(`Delete project "${project.name}"?`)) return;
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
