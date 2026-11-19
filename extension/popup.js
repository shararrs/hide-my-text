const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const MASK = "••••••••";
let items = [], selectedNewAction = "";

async function call(msg) {
  const r = await api.runtime.sendMessage(msg);
  if (!r || !r.ok) throw new Error((r && r.error) || "Failed");
  return r;
}
const guard = (fn) => async (...a) => {
  $("err").textContent = "";
  try { await fn(...a); } catch (e) { $("err").textContent = e.message; }
};
async function reloadTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) api.tabs.reload(tab.id);
}

// In-page dialog (window.prompt/confirm are unreliable in extension popups). Resolves null on cancel.
function ask(message, withInput) {
  return new Promise((resolve) => {
    $("modalMsg").textContent = message;
    $("modalInput").classList.toggle("hidden", !withInput);
    $("modalInput").value = "";
    $("modal").classList.remove("hidden");
    if (withInput) $("modalInput").focus();
    const done = (v) => { $("modal").classList.add("hidden"); resolve(v); };
    $("modalOk").onclick = () => done(withInput ? $("modalInput").value : true);
    $("modalCancel").onclick = () => done(null);
    $("modalInput").onkeydown = (e) => { if (e.key === "Enter") $("modalOk").click(); };
  });
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", t);
  applyTheme(t);
};

const open = new Set();
const cleanHost = (h) => String(h).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^\*\./, "").replace(/^www\./, "");
const splitSites = (v) => v.split(/[,\s]+/).map(cleanHost).filter(Boolean);
const sitesLabel = (it) => (!it.sites.length ? "all sites" : it.sites.length === 1 ? it.sites[0] : "multi-site");

function mk(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}
function actionTabs(initialValue, onChange) {
  const container = mk("div", { className: "btn-tabs", role: "group", "aria-label": "Hiding method" });
  let currentVal = initialValue || "";
  const buttons = [
    { val: "blur", label: "Blur" },
    { val: "replace", label: "Replace With" },
    { val: "delete", label: "Delete" }
  ].map(({ val, label }) => {
    const btn = mk("button", {
      type: "button",
      className: currentVal === val ? "active" : "",
      textContent: label,
      "aria-pressed": currentVal === val ? "true" : "false"
    });
    btn.onclick = () => {
      currentVal = val;
      buttons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      onChange(currentVal);
    };
    container.append(btn);
    return btn;
  });
  return {
    el: container,
    getValue: () => currentVal,
    setValue: (val) => {
      currentVal = val || "";
      buttons.forEach((b, idx) => {
        const v = ["blur", "replace", "delete"][idx];
        const isActive = v === currentVal;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      onChange(currentVal);
    }
  };
}

function editor(it, i) {
  const draft = { sites: [...it.sites] };
  const box = mk("div", { className: "edit" });
  
  const textInput = mk("input", { type: "password", placeholder: "Leave blank to keep current hidden text", autocomplete: "off" });
  const toggleTextBtn = mk("button", { type: "button", className: "icon peek", textContent: "👁", title: "Toggle visibility" });
  toggleTextBtn.onclick = () => {
    const isPw = textInput.type === "password";
    textInput.type = isPw ? "text" : "password";
    toggleTextBtn.textContent = isPw ? "🙈" : "👁";
  };
  const textRow = mk("div", { className: "input-wrap", style: "margin: 3px 0;" }, textInput, toggleTextBtn);

  const name = mk("input", { value: it.name, placeholder: "Label for the hidden text" });
  const nameErr = mk("div", { className: "field-err hidden", textContent: "Label is required for all sites to easily track" });
  name.oninput = () => {
    name.classList.remove("input-error");
    nameErr.classList.add("hidden");
  };

  const repl = mk("input", { value: it.replacement, placeholder: "Replacement text (default: •••)", "aria-label": "Replacement text (default: •••)" });
  const actionErr = mk("div", { className: "field-err hidden", textContent: "Please select a method to hide text" });
  const tabs = actionTabs(it.mode || "", (val) => {
    actionErr.classList.add("hidden");
    repl.classList.toggle("hidden", val !== "replace");
  });
  repl.classList.toggle("hidden", it.mode !== "replace");

  const list = mk("div");
  const drawSites = () => {
    list.textContent = "";
    if (!draft.sites.length) list.append(mk("div", { className: "muted", textContent: "Applies to all sites" }));
    draft.sites.forEach((s, k) => list.append(mk("div", { className: "site" }, mk("span", { textContent: s }),
      mk("button", { className: "icon danger", textContent: "✕", onclick: () => { draft.sites.splice(k, 1); drawSites(); } }))));
  };
  drawSites();
  const addSites = mk("input", { placeholder: "Add site(s), e.g. example.com" });
  const addBtn = mk("button", { textContent: "Add", onclick: () => { splitSites(addSites.value).forEach((s) => { if (!draft.sites.includes(s)) draft.sites.push(s); }); addSites.value = ""; drawSites(); } });
  const curBtn = mk("button", { textContent: "Use current site", onclick: guard(async () => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const host = cleanHost(new URL(tab.url).hostname);
    if (host && !draft.sites.includes(host)) draft.sites.push(host);
    drawSites();
  }) });
  const allBtn = mk("button", { textContent: "All sites", onclick: () => { draft.sites = []; drawSites(); } });
  const save = mk("button", { className: "primary", textContent: "Save", onclick: guard(async () => {
    splitSites(addSites.value).forEach((s) => { if (!draft.sites.includes(s)) draft.sites.push(s); });
    if (!draft.sites.length && !name.value.trim()) {
      name.classList.add("input-error");
      nameErr.classList.remove("hidden");
      name.focus();
      return;
    }
    const chosenMode = tabs.getValue();
    if (!chosenMode) {
      actionErr.classList.remove("hidden");
      tabs.el.querySelector("button")?.focus();
      return;
    }
    const updatePayload = { index: i, name: name.value, sites: draft.sites, mode: chosenMode, replacement: repl.value.trim() || "•••" };
    if (textInput.value) {
      updatePayload.text = textInput.value;
    }
    await call({ type: "updateItem", ...updatePayload });
    open.delete(i);
    await refresh();
    await reloadTab();
  }) });
  box.append(
    mk("h3", { textContent: "Edit Text & Settings" }),
    textRow,
    mk("h3", { textContent: "Sites" }),
    list,
    mk("div", { className: "row" }, addSites, addBtn),
    mk("div", { className: "actions" }, curBtn, allBtn),
    name,
    nameErr,
    tabs.el,
    actionErr,
    repl,
    save
  );
  return box;
}

function renderItems() {
  const ul = $("items");
  ul.textContent = "";
  if (!items.length) {
    ul.append(mk("div", { className: "empty", textContent: "Nothing added yet" }));
    return;
  }
  items.forEach((it, i) => {
    const sub = mk("div", { className: "sub", textContent: MASK });
    const chip = mk("span", { className: "chip", textContent: sitesLabel(it) });
    chip.title = it.sites.length ? it.sites.join("\n") : "All sites";
    const show = mk("button", { className: "icon", textContent: "👁", title: "Show text (needs master password)" });
    const hide = () => { sub.textContent = MASK; delete show.dataset.shown; };
    show.onclick = guard(async () => {
      if (show.dataset.shown) return hide();
      const password = await ask("Master password to show this text:", true);
      if (password === null) return;
      sub.textContent = (await call({ type: "reveal", index: i, password })).text;
      show.dataset.shown = "1";
      setTimeout(hide, 10000);
    });
    const gear = mk("button", { className: "icon", textContent: "⚙", title: "Edit text, name, sites and action", onclick: () => { open.has(i) ? open.delete(i) : open.add(i); renderItems(); } });
    const del = mk("button", { className: "icon danger", textContent: "✕", onclick: guard(async () => { open.clear(); await call({ type: "removeItem", index: i }); await refresh(); await reloadTab(); }) });
    const li = mk("li", {}, mk("div", { className: "item-info" }, mk("div", { className: "name", textContent: it.name || "(unnamed)" }), sub), chip, show, gear, del);
    const wrap = mk("div", { className: "item" }, li);
    if (open.has(i)) wrap.append(editor(it, i));
    ul.append(wrap);
  });
}function render() {
  renderItems();
}

async function refresh() {
  const st = await call({ type: "status" });
  $("auth").classList.toggle("hidden", st.unlocked);
  $("main").classList.toggle("hidden", !st.unlocked);
  if (!st.unlocked) {
    $("pw2").classList.toggle("hidden", st.initialized);
    $("forgot").classList.toggle("hidden", !st.initialized);
    $("authMsg").textContent = st.initialized ? "Enter your master password." : "First start: choose a master password (min 8 characters). It cannot be recovered.";
    $("authBtn").textContent = st.initialized ? "Unlock" : "Create";
    $("authBtn").dataset.init = st.initialized ? "1" : "";
    return;
  }
  ({ items } = await call({ type: "getData" }));
  render();
}

$("authBtn").onclick = guard(async () => {
  const password = $("pw").value;
  if ($("authBtn").dataset.init) await call({ type: "unlock", password });
  else {
    if (password !== $("pw2").value) throw new Error("Passwords do not match");
    await call({ type: "setup", password });
  }
  $("pw").value = $("pw2").value = "";
  await refresh();
  await reloadTab();
});
$("pw").onkeydown = $("pw2").onkeydown = (e) => { if (e.key === "Enter") $("authBtn").click(); };
$("forgot").onclick = guard(async () => {
  if (!(await ask("Resetting the master password DELETES all saved texts, site scopes and preferences. This cannot be undone. Continue?"))) return;
  await call({ type: "reset" });
  await refresh();
  await reloadTab();
});

$("toggleNewText").onclick = () => {
  const isPw = $("newText").type === "password";
  $("newText").type = isPw ? "text" : "password";
  $("toggleNewText").textContent = isPw ? "🙈" : "👁";
};

let selectedScope = "all";
function setScope(scope) {
  selectedScope = scope === "some" ? "some" : "all";
  const isAll = selectedScope === "all";
  $("scopeAll").classList.toggle("active", isAll);
  $("scopeAll").setAttribute("aria-selected", isAll ? "true" : "false");
  $("scopeSome").classList.toggle("active", !isAll);
  $("scopeSome").setAttribute("aria-selected", !isAll ? "true" : "false");
  $("sitesBox").classList.toggle("hidden", isAll);
}

$("scopeAll").onclick = () => setScope("all");
$("scopeSome").onclick = () => setScope("some");
$("scopeAll").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScope("all"); } };
$("scopeSome").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScope("some"); } };
$("addCurrent").onclick = guard(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const host = cleanHost(new URL(tab.url).hostname);
  const cur = splitSites($("newSites").value);
  if (host && !cur.includes(host)) cur.push(host);
  $("newSites").value = cur.join(", ");
});
$("newText").oninput = () => {
  $("newText").classList.remove("input-error");
  $("newTextErr").classList.add("hidden");
};
$("newSites").oninput = () => {
  $("newSites").classList.remove("input-error");
  $("newSitesErr").classList.add("hidden");
};
$("newName").oninput = () => {
  $("newName").classList.remove("input-error");
  $("newNameErr").classList.add("hidden");
};

const newActionBtns = document.querySelectorAll("#newActionTabs button");
newActionBtns.forEach((btn) => {
  btn.onclick = () => {
    selectedNewAction = btn.dataset.val;
    newActionBtns.forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    $("newActionTabs").classList.remove("input-error");
    $("newActionErr").classList.add("hidden");
    $("newReplacement").classList.toggle("hidden", selectedNewAction !== "replace");
  };
});

function clearNewErrors() {
  $("newText").classList.remove("input-error");
  $("newTextErr").classList.add("hidden");
  $("newSites").classList.remove("input-error");
  $("newSitesErr").classList.add("hidden");
  $("newName").classList.remove("input-error");
  $("newNameErr").classList.add("hidden");
  $("newActionTabs").classList.remove("input-error");
  $("newActionErr").classList.add("hidden");
}

function resetNewForm() {
  $("newText").value = $("newSites").value = $("newName").value = $("newReplacement").value = "";
  $("newText").type = "password";
  $("toggleNewText").textContent = "👁";
  clearNewErrors();
  selectedNewAction = "";
  newActionBtns.forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-pressed", "false");
  });
  $("newReplacement").classList.add("hidden");
  setScope("all");
}

$("addText").onclick = guard(async () => {
  clearNewErrors();
  const text = $("newText").value.trim();
  if (!text) {
    $("newText").classList.add("input-error");
    $("newTextErr").classList.remove("hidden");
    $("newText").focus();
    return;
  }
  const specific = selectedScope === "some";
  const sites = specific ? splitSites($("newSites").value) : [];
  if (specific && !sites.length) {
    $("newSites").classList.add("input-error");
    $("newSitesErr").classList.remove("hidden");
    $("newSites").focus();
    return;
  }
  if (!specific && !$("newName").value.trim()) {
    $("newName").classList.add("input-error");
    $("newNameErr").classList.remove("hidden");
    $("newName").focus();
    return;
  }
  if (!selectedNewAction) {
    $("newActionTabs").classList.add("input-error");
    $("newActionErr").classList.remove("hidden");
    newActionBtns[0]?.focus();
    return;
  }
  const replVal = selectedNewAction === "replace" ? ($("newReplacement").value.trim() || "•••") : "";
  await call({ type: "addItem", item: { name: $("newName").value, text, sites, mode: selectedNewAction, replacement: replVal } });
  resetNewForm();
  await refresh();
  await reloadTab();
});
$("lock").onclick = guard(async () => { await call({ type: "lock" }); await refresh(); await reloadTab(); });

guard(refresh)();
