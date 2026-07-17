const STORAGE_KEY = "chore-tracker:chores";
const DAY_MS = 24 * 60 * 60 * 1000;

function loadChores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveChores(chores) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chores));
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysUntil(dueDate) {
  return Math.round((startOfDay(dueDate) - startOfDay(Date.now())) / DAY_MS);
}

function frequencyLabel(days) {
  if (days === 1) return "Daily";
  if (days === 7) return "Weekly";
  if (days === 14) return "Every 2 weeks";
  if (days === 30) return "Monthly";
  return `Every ${days} days`;
}

function dueLabel(dueDate) {
  const diff = daysUntil(dueDate);
  if (diff < 0) return diff === -1 ? "1 day overdue" : `${-diff} days overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due in ${diff} days`;
}

function cardStatus(dueDate) {
  const diff = daysUntil(dueDate);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "";
}

let chores = loadChores();

const listEl = document.getElementById("chore-list");
const emptyStateEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("summary");
const addBtn = document.getElementById("add-btn");
const addDialog = document.getElementById("add-dialog");
const addForm = document.getElementById("add-form");
const cancelBtn = document.getElementById("cancel-btn");
const nameInput = document.getElementById("chore-name");
const frequencySelect = document.getElementById("chore-frequency");
const customDaysWrap = document.getElementById("custom-days-wrap");
const customDaysInput = document.getElementById("custom-days");

function render() {
  const sorted = [...chores].sort((a, b) => a.dueDate - b.dueDate);

  listEl.innerHTML = "";
  emptyStateEl.hidden = sorted.length > 0;

  const overdueCount = chores.filter((c) => daysUntil(c.dueDate) < 0).length;
  const todayCount = chores.filter((c) => daysUntil(c.dueDate) === 0).length;
  if (chores.length === 0) {
    summaryEl.textContent = "";
  } else {
    const parts = [];
    if (overdueCount) parts.push(`${overdueCount} overdue`);
    if (todayCount) parts.push(`${todayCount} due today`);
    summaryEl.textContent = parts.length
      ? parts.join(" · ")
      : "All caught up";
  }

  for (const chore of sorted) {
    const card = document.createElement("div");
    const status = cardStatus(chore.dueDate);
    card.className = `chore-card${status ? " " + status : ""}`;

    const info = document.createElement("div");
    info.className = "chore-info";
    const name = document.createElement("p");
    name.className = "chore-name";
    name.textContent = chore.name;
    const meta = document.createElement("p");
    meta.className = "chore-meta";
    meta.textContent = `${dueLabel(chore.dueDate)} · ${frequencyLabel(chore.frequencyDays)}`;
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "chore-actions";

    const doneBtn = document.createElement("button");
    doneBtn.className = "done-btn";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", () => markDone(chore.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "✕";
    deleteBtn.setAttribute("aria-label", `Delete ${chore.name}`);
    deleteBtn.addEventListener("click", () => deleteChore(chore.id));

    actions.append(doneBtn, deleteBtn);
    card.append(info, actions);
    listEl.appendChild(card);
  }
}

function markDone(id) {
  const chore = chores.find((c) => c.id === id);
  if (!chore) return;
  chore.dueDate = startOfDay(Date.now()) + chore.frequencyDays * DAY_MS;
  saveChores(chores);
  render();
}

function deleteChore(id) {
  chores = chores.filter((c) => c.id !== id);
  saveChores(chores);
  render();
}

function resetForm() {
  addForm.reset();
  customDaysWrap.hidden = true;
}

addBtn.addEventListener("click", () => {
  resetForm();
  addDialog.showModal();
});

cancelBtn.addEventListener("click", () => {
  addDialog.close();
});

frequencySelect.addEventListener("change", () => {
  customDaysWrap.hidden = frequencySelect.value !== "custom";
});

addForm.addEventListener("submit", (e) => {
  const name = nameInput.value.trim();
  if (!name) {
    e.preventDefault();
    return;
  }

  const frequencyDays =
    frequencySelect.value === "custom"
      ? Math.max(1, parseInt(customDaysInput.value, 10) || 1)
      : parseInt(frequencySelect.value, 10);

  chores.push({
    id: crypto.randomUUID(),
    name,
    frequencyDays,
    dueDate: startOfDay(Date.now()),
  });
  saveChores(chores);
  render();
});

render();
