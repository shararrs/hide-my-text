const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
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
function list(id, values, remove) {
  const ul = $(id);
  ul.textContent = "";
  values.forEach((v, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = v;
    const b = document.createElement("button");
    b.textContent = "✕";
    b.onclick = guard(() => remove(i));
    li.append(span, b);
    ul.append(li);
  });
}
function render() {
  list("items", items, async (i) => { items.splice(i, 1); await saveItems(); });
  list("sites", settings.sites, async (i) => { settings.sites.splice(i, 1); await saveSettings(); });
  $("mode").value = settings.mode;
  $("replacement").value = settings.replacement;
  $("replacement").classList.toggle("hidden", settings.mode !== "replace");
}
async function saveItems() { await call({ type: "saveItems", items }); await refresh(); await reloadTab(); }
async function saveSettings() { await call({ type: "saveSettings", settings }); await refresh(); await reloadTab(); }

async function refresh() {
  const st = await call({ type: "status" });
  $("auth").classList.toggle("hidden", st.unlocked);
  $("main").classList.toggle("hidden", !st.unlocked);
  if (!st.unlocked) {
    $("pw2").classList.toggle("hidden", st.initialized);
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
});
$("addText").onclick = guard(async () => {
  const v = $("newText").value.trim();
  if (!v) return;
  items.push(v); $("newText").value = ""; await saveItems();
});
$("addSite").onclick = guard(async () => {
  const v = $("newSite").value.trim();
  if (!v) return;
  settings.sites.push(v); $("newSite").value = ""; await saveSettings();
});
$("addCurrent").onclick = guard(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  settings.sites.push(new URL(tab.url).hostname);
  await saveSettings();
});
$("mode").onchange = guard(async () => { settings.mode = $("mode").value; await saveSettings(); });
$("replacement").onchange = guard(async () => { settings.replacement = $("replacement").value; await saveSettings(); });
$("lock").onclick = guard(async () => { await call({ type: "lock" }); await refresh(); await reloadTab(); });

guard(refresh)();
