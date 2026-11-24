"use strict";

const byId = (id) => document.getElementById(id);
const storageKey = "gigamakyeo-actors-voice-assignments-v1";
const pageSize = 72;
const maximumVoiceLength = 256;
const genderLabels = { F: "여성", M: "남성" };
const tabButtons = [byId("catalog-tab"), byId("assign-tab")];
const detailContent = byId("detail-content");
const detailPhoto = byId("detail-photo");
const detailVoice = byId("detail-voice");
const batchVoice = byId("batch-voice");
const status = byId("status");
const emptyDetail = byId("detail-empty");
const importButton = byId("import-button");
const exportButton = byId("export-button");
const importFile = byId("import-file");
const searchText = (value) => value.normalize("NFC").toLocaleLowerCase("ko");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const currentVoice = () => batchVoice.value.trim();

let actors = [];
let actorsById = new Map();
let assignments = new Map();
let lists = [];
let selectedId = null;
let activeTabIndex = 0;
let ready = false;
let storageAvailable = true;
let statusTimer;

function announce(message, error = false) {
  clearTimeout(statusTimer);
  status.toggleAttribute("data-error", error);
  status.textContent = message;
  statusTimer = setTimeout(() => { status.textContent = ""; }, error ? 7500 : 3500);
}

function setStorageUnavailable(note) {
  storageAvailable = false;
  const saveNote = document.querySelector(".save-note");
  saveNote.setAttribute("data-unavailable", "");
  saveNote.lastChild.textContent = note;
}

function cleanAssignments(input, strict) {
  if (!isObject(input)) {
    throw new Error("인물 보이스 배정 백업 형식이 올바르지 않습니다.");
  }

  const clean = new Map();
  let skipped = 0;
  for (const [id, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim() || value.length > maximumVoiceLength) {
      if (strict) {
        throw new Error("백업에 올바르지 않은 보이스 ID가 있습니다.");
      }
      continue;
    }
    if (!actorsById.has(id)) {
      skipped += 1;
      continue;
    }
    clean.set(id, value.trim());
  }
  return { clean, skipped };
}

function loadAssignments() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      assignments = cleanAssignments(JSON.parse(saved), false).clean;
    }
  } catch (error) {
    if (error instanceof SyntaxError || error.name === "Error") {
      announce("기존 배정 데이터를 읽을 수 없습니다. 백업을 불러올 수 있습니다.", true);
    } else {
      setStorageUnavailable("이 브라우저에서 저장할 수 없음");
    }
  }
}

function saveAssignments(next) {
  assignments = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(next)));
    if (!storageAvailable) {
      const saveNote = document.querySelector(".save-note");
      saveNote.removeAttribute("data-unavailable");
      saveNote.lastChild.textContent = "이 브라우저에 저장";
    }
    storageAvailable = true;
  } catch {
    setStorageUnavailable("저장 실패 · 백업 필요");
  }
  return storageAvailable;
}

function makeFilter(details, choices) {
  const inputs = choices.map(([value, text]) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    label.append(input, document.createTextNode(text));
    details.querySelector("[data-options]").append(label);
    return input;
  });

  return {
    details,
    inputs,
    read() {
      const selected = new Set(inputs.filter((input) => input.checked).map((input) => input.value));
      details.toggleAttribute("data-active", selected.size > 0);
      details.querySelector("[data-selection]").textContent = selected.size > 0 ? selected.size : "";
      return selected;
    },
  };
}

function createList(id, mode, ages) {
  const root = byId(id);
  root.append(byId("list-template").content.cloneNode(true));
  const search = root.querySelector("[data-search]");
  search.setAttribute("aria-label", `${root.querySelector("h2").textContent} 검색`);
  const filters = [
    makeFilter(root.querySelector("[data-gender]"), Object.entries(genderLabels)),
    makeFilter(root.querySelector("[data-age]"), ages),
  ];

  if (mode === "catalog") {
    const details = root.querySelector("[data-gender]").cloneNode(true);
    details.removeAttribute("data-gender");
    details.querySelector("summary").firstChild.textContent = "배정 상태 ";
    details.querySelector("[data-options]").replaceChildren();
    root.querySelector("[data-reset]").before(details);
    filters.push(makeFilter(details, [["assigned", "배정됨"], ["unassigned", "미배정"]]));
  }

  const list = {
    root,
    mode,
    search,
    filters,
    grid: root.querySelector("[data-grid]"),
    empty: root.querySelector("[data-empty]"),
    count: root.querySelector("[data-count]"),
    reset: root.querySelector("[data-reset]"),
    more: root.querySelector("[data-more]"),
    limit: pageSize,
  };

  const changeFilter = () => {
    list.limit = pageSize;
    renderList(list);
  };
  search.addEventListener("input", changeFilter);
  for (const { details } of filters) {
    details.addEventListener("change", changeFilter);
  }
  list.reset.addEventListener("click", () => {
    search.value = "";
    for (const { details, inputs } of filters) {
      details.open = false;
      for (const input of inputs) {
        input.checked = false;
      }
    }
    changeFilter();
    search.focus();
  });
  list.more.addEventListener("click", () => {
    list.limit += pageSize;
    renderList(list, { append: true });
  });
  list.grid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-actor]");
    if (card) {
      activateCard(list, card.dataset.actor, card);
    }
  });
  return list;
}

function makeCard(actor, mode) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.dataset.actor = actor.id;
  if (mode === "catalog") {
    card.setAttribute("aria-pressed", String(actor.id === selectedId));
    card.setAttribute("aria-controls", "detail-content");
  } else {
    const action = mode === "assigned" ? "배정 해제" : "배정";
    card.setAttribute("aria-label", `${actor.name}, ${actor.meta}, 보이스 ${action}`);
  }

  const image = document.createElement("img");
  image.src = actor.thumbnail || actor.image;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  if (!actor.thumbnail) {
    image.className = "sheet-photo";
  }
  const info = document.createElement("span");
  info.className = "card-info";
  const meta = document.createElement("span");
  meta.className = "card-meta";
  meta.textContent = actor.meta;
  const name = document.createElement("span");
  name.className = "card-name";
  name.textContent = actor.name;
  info.append(meta, name);
  card.append(image, info);
  return card;
}

function renderList(list, { append = false, focusIndex = null } = {}) {
  const [genders, ages, states] = list.filters.map((filter) => filter.read());
  const words = searchText(list.search.value.trim()).split(/\s+/).filter(Boolean);
  const voice = currentVoice();
  list.reset.hidden = words.length === 0 && !genders.size && !ages.size && !states?.size;
  let total = 0;
  let matches = [];

  for (const actor of actors) {
    const assigned = assignments.get(actor.id);
    if (list.mode === "unassigned" && assigned) {
      continue;
    }
    if (list.mode === "assigned" && (!voice || assigned !== voice)) {
      continue;
    }
    total += 1;
    const searchable = assigned ? `${actor.searchable} ${searchText(assigned)}` : actor.searchable;
    if ((!genders.size || genders.has(actor.gender)) &&
        (!ages.size || ages.has(actor.decade)) &&
        (!states?.size || states.has(assigned ? "assigned" : "unassigned")) &&
        words.every((word) => searchable.includes(word))) {
      matches.push(actor);
    }
  }

  const count = matches.length.toLocaleString("ko-KR");
  list.count.textContent = matches.length === total ? `${count}명` : `${count} / ${total.toLocaleString("ko-KR")}명`;
  list.empty.hidden = matches.length > 0;
  list.empty.textContent = list.mode === "assigned" && !voice ? "아래에 보이스 ID를 입력하세요." : "조건에 맞는 인물이 없습니다.";
  list.more.hidden = matches.length <= list.limit;
  if (!list.more.hidden) {
    list.more.textContent = `${Math.min(pageSize, matches.length - list.limit)}명 더 보기`;
  }
  const fragment = document.createDocumentFragment();
  const oldCount = append ? list.grid.childElementCount : 0;
  for (const actor of matches.slice(oldCount, list.limit)) {
    fragment.append(makeCard(actor, list.mode));
  }
  if (append) {
    list.grid.append(fragment);
    list.grid.children[oldCount]?.focus();
  } else {
    list.grid.replaceChildren(fragment);
  }
  if (focusIndex !== null) {
    const next = list.grid.children[Math.min(focusIndex, list.grid.childElementCount - 1)] || list.search;
    next.focus({ preventScroll: true });
  }
}

function renderDetail() {
  const actor = actorsById.get(selectedId);
  emptyDetail.hidden = Boolean(actor);
  detailContent.hidden = !actor;
  if (!actor) {
    return;
  }

  detailPhoto.src = actor.image;
  detailPhoto.alt = `${actor.name} 인물 시트`;
  byId("detail-name").textContent = actor.name;
  byId("detail-meta").textContent = actor.meta;
  byId("detail-description").textContent = actor.description;
  detailVoice.value = assignments.get(actor.id) || "";
  byId("detail-remove").disabled = !assignments.has(actor.id);
}

function applyAssignment(id, voice, origin = null, focusIndex = null) {
  const next = new Map(assignments);
  if (voice) {
    next.set(id, voice);
  } else {
    next.delete(id);
  }

  const saved = saveAssignments(next);
  if (selectedId === id) {
    renderDetail();
  }
  for (const list of lists) {
    renderList(list, { focusIndex: list === origin ? focusIndex : null });
  }

  const name = actorsById.get(id).name;
  if (saved) {
    announce(voice ? `${name} 님에게 보이스를 배정했습니다.` : `${name} 님의 보이스 배정을 해제했습니다.`);
  } else {
    announce("화면에만 반영되었습니다. 배정을 보관하려면 백업을 다운로드하세요.", true);
  }
}

function activateCard(list, id, card) {
  if (list.mode === "catalog") {
    if (selectedId !== id) {
      list.grid.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
      selectedId = id;
      card.setAttribute("aria-pressed", "true");
      renderDetail();
    }
    if (matchMedia("(max-width: 760px)").matches) {
      detailContent.scrollIntoView({ block: "start" });
      byId("detail-jump").focus({ preventScroll: true });
    }
    return;
  }

  const voice = currentVoice();
  if (!voice) {
    announce("먼저 보이스 ID를 입력하세요.", true);
    batchVoice.focus();
    return;
  }
  const focusIndex = Array.prototype.indexOf.call(list.grid.children, card);
  applyAssignment(id, list.mode === "assigned" ? "" : voice, list, focusIndex);
}

function selectTab(index, focus = false) {
  activeTabIndex = index;
  tabButtons.forEach((tab, tabIndex) => {
    const active = tabIndex === index;
    tab.tabIndex = active ? 0 : -1;
    tab.setAttribute("aria-selected", String(active));
    byId(tab.getAttribute("aria-controls")).hidden = !active || !ready;
  });
  if (focus) {
    tabButtons[index].focus();
  }
}

function importBackup(event) {
  const file = event.target.files[0];
  if (!file || !ready) {
    return;
  }
  importFile.value = "";
  file.text().then((text) => {
    const backup = JSON.parse(text);
    if (backup?.version !== 1) {
      throw new Error("지원하는 인물 보이스 배정 백업이 아닙니다.");
    }
    const { clean, skipped } = cleanAssignments(backup.assignments, true);
    if (skipped && !clean.size) {
      throw new Error("현재 목록에 해당하는 인물이 백업에 없습니다.");
    }

    const next = new Map([...assignments, ...clean]);
    const saved = saveAssignments(next);
    renderDetail();
    for (const list of lists) {
      renderList(list);
    }
    const skippedNote = skipped ? ` 현재 목록에 없는 ${skipped}명은 건너뛰었습니다.` : "";
    const savedNote = saved ? "" : " 이 브라우저에 저장하지 못했습니다.";
    announce(`인물 ${clean.size}명의 배정을 불러왔습니다.${skippedNote}${savedNote}`, !saved);
  }).catch((error) => {
    announce(error instanceof SyntaxError ? "백업 JSON 파일을 읽을 수 없습니다." : error.message, true);
  });
}

function exportBackup() {
  const backup = { version: 1, assignments: Object.fromEntries(assignments) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "인물_보이스_배정_백업.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  importButton.disabled = true;
  exportButton.disabled = true;
  tabButtons.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(index));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        selectTab(1 - index, true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        selectTab(event.key === "Home" ? 0 : 1, true);
      }
    });
  });

  document.addEventListener("pointerdown", (event) => {
    for (const details of document.querySelectorAll(".filter[open]")) {
      if (!details.contains(event.target)) {
        details.open = false;
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    const details = event.target.closest(".filter[open]");
    if (event.key === "Escape" && details) {
      details.open = false;
      details.querySelector("summary").focus();
    }
  });

  try {
    const response = await fetch("actors.json");
    if (!response.ok) {
      throw new Error(`actors.json HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("actors.json must be an array");
    }
    actors = data.map((item) => {
      const id = String(item.id);
      const gender = item.gender.toUpperCase();
      const age = Number(item.age);
      const description = item.description || "";
      const genderLabel = genderLabels[gender] || gender;
      return {
        ...item,
        id,
        gender,
        age,
        description,
        meta: `${genderLabel} · ${age}세`,
        decade: String(Math.floor(age / 10) * 10),
        searchable: searchText([item.name, description, id, genderLabel, gender, age, `${age}세`].join(" ")),
      };
    });
    actorsById = new Map(actors.map((actor) => [actor.id, actor]));
    loadAssignments();
    const ages = [...new Set(actors.map((actor) => actor.decade))]
      .sort((left, right) => Number(left) - Number(right))
      .map((decade) => [decade, `${decade}대`]);
    lists = [
      createList("catalog-list", "catalog", ages),
      createList("unassigned-list", "unassigned", ages),
      createList("assigned-list", "assigned", ages),
    ];
    for (const list of lists) {
      renderList(list);
    }
    ready = true;
    byId("load-message").hidden = true;
    selectTab(activeTabIndex);
    importButton.disabled = false;
    exportButton.disabled = false;
  } catch (error) {
    byId("load-message").textContent = "인물 목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.";
    console.error("인물 목록 로드 실패", error);
  }
}

byId("detail-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const voice = detailVoice.value.trim();
  if (!voice) {
    announce("저장할 보이스 ID를 입력하세요. 기존 배정은 배정 해제로 지울 수 있습니다.", true);
    detailVoice.focus();
    return;
  }
  applyAssignment(selectedId, voice);
});
byId("detail-remove").addEventListener("click", () => {
  applyAssignment(selectedId, "");
  detailVoice.focus();
});
byId("detail-jump").addEventListener("click", () => {
  const catalog = lists[0];
  const selected = catalog.grid.querySelector('[aria-pressed="true"]');
  (selected || catalog.search).focus();
});
batchVoice.addEventListener("input", () => {
  const assignedList = lists[2];
  if (assignedList) {
    assignedList.limit = pageSize;
    renderList(assignedList);
  }
});
importButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", importBackup);
exportButton.addEventListener("click", exportBackup);
window.addEventListener("storage", (event) => {
  if (event.key === storageKey && ready) {
    assignments = new Map();
    loadAssignments();
    renderDetail();
    for (const list of lists) {
      renderList(list);
    }
  }
});

init();
