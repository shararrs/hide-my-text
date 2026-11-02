const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const MASK = "••••••••";
let items = [], settings = {};

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
const splitSites = (v) => v.split(/[,\s]+/).filter(Boolean);
const sitesLabel = (it) => (!it.sites.length ? "all sites" : it.sites.length === 1 ? it.sites[0] : "multi-site");

function mk(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}
function modeSelect(value) {
  const s = mk("select");
  [["", "Default action"], ["blur", "Blur"], ["replace", "Replace"], ["delete", "Delete"]].forEach(([v, t]) => s.append(mk("option", { value: v, textContent: t })));
  s.value = value;
  return s;
}

function editor(it, i) {
  const draft = { sites: [...it.sites] };
  const box = mk("div", { className: "edit" });
  const name = mk("input", { value: it.name, placeholder: "Name" });
  const mode = modeSelect(it.mode);
  const repl = mk("input", { value: it.replacement, placeholder: "Replacement text" });
  const syncRepl = () => repl.classList.toggle("hidden", mode.value !== "replace");
  mode.onchange = syncRepl;
  syncRepl();
  const list = mk("div");
  const drawSites = () => {
    list.textContent = "";
    if (!draft.sites.length) list.append(mk("div", { className: "muted", textContent: "Applies to all sites" }));
    draft.sites.forEach((s, k) => list.append(mk("div", { className: "site" }, mk("span", { textContent: s }),
      mk("button", { className: "icon danger", textContent: "✕", onclick: () => { draft.sites.splice(k, 1); drawSites(); } }))));
  };
  drawSites();
  const addSites = mk("input", { placeholder: "Add site(s), e.g. example.com" });
  const addBtn = mk("button", { textContent: "Add", onclick: () => { splitSites(addSites.value).forEach((s) => draft.sites.push(s)); addSites.value = ""; drawSites(); } });
  const curBtn = mk("button", { textContent: "Use current site", onclick: guard(async () => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    draft.sites.push(new URL(tab.url).hostname);
    drawSites();
  }) });
  const allBtn = mk("button", { textContent: "Switch to all sites", onclick: () => { draft.sites = []; drawSites(); } });
  const save = mk("button", { className: "primary", textContent: "Save", onclick: guard(async () => {
    draft.sites.push(...splitSites(addSites.value));
    await call({ type: "updateItem", index: i, name: name.value, sites: draft.sites, mode: mode.value, replacement: repl.value });
    open.delete(i);
    await refresh();
    await reloadTab();
  }) });
  box.append(name, mode, repl, mk("h3", { textContent: "Sites" }), list, mk("div", { className: "row" }, addSites, addBtn),
    mk("div", { className: "actions" }, curBtn, allBtn), save);
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
    const gear = mk("button", { className: "icon", textContent: "⚙", title: "Edit name, sites and action", onclick: () => { open.has(i) ? open.delete(i) : open.add(i); renderItems(); } });
    const del = mk("button", { className: "icon danger", textContent: "✕", onclick: guard(async () => { open.clear(); await call({ type: "removeItem", index: i }); await refresh(); await reloadTab(); }) });
    const li = mk("li", {}, mk("div", { style: "flex:1;min-width:0" }, mk("div", { className: "name", textContent: it.name || "(unnamed)" }), sub), chip, show, gear, del);
    const wrap = mk("div", { className: "item" }, li);
    if (open.has(i)) wrap.append(editor(it, i));
    ul.append(wrap);
  });
}function render() {
  renderItems();
  $("mode").value = settings.mode;
  $("replacement").value = settings.replacement;
  $("replacement").classList.toggle("hidden", settings.mode !== "replace");
}
async function saveSettings() { await call({ type: "saveSettings", settings }); await refresh(); await reloadTab(); }

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
  ({ items, settings } = await call({ type: "getData" }));
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

document.querySelectorAll("input[name=scope]").forEach((r) => {
  r.onchange = () => $("sitesBox").classList.toggle("hidden", document.querySelector("input[name=scope]:checked").value !== "some");
});
$("addCurrent").onclick = guard(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const host = new URL(tab.url).hostname;
  const cur = $("newSites").value.split(/[,\s]+/).filter(Boolean);
  if (!cur.includes(host)) cur.push(host);
  $("newSites").value = cur.join(", ");
});
$("addText").onclick = guard(async () => {
  const text = $("newText").value.trim();
  if (!text) return;
  const specific = document.querySelector("input[name=scope]:checked").value === "some";
  const sites = specific ? splitSites($("newSites").value) : [];
  if (specific && !sites.length) throw new Error("Enter at least one website or choose All sites");
  await call({ type: "addItem", item: { name: $("newName").value, text, sites, mode: $("newMode").value, replacement: $("newReplacement").value } });
  $("newText").value = $("newSites").value = $("newName").value = $("newReplacement").value = "";
  await refresh();
  await reloadTab();
});
$("newMode").onchange = () => $("newReplacement").classList.toggle("hidden", $("newMode").value !== "replace");
$("mode").onchange = guard(async () => { settings.mode = $("mode").value; await saveSettings(); });
$("replacement").onchange = guard(async () => { settings.replacement = $("replacement").value; await saveSettings(); });
$("lock").onclick = guard(async () => { await call({ type: "lock" }); await refresh(); await reloadTab(); });

guard(refresh)();
