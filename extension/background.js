/* global Vault */
if (typeof importScripts === "function") importScripts("vault.js");

const api = globalThis.browser || globalThis.chrome;
const MIN_PASSWORD = 8;
const DEFAULT_SETTINGS = { mode: "blur", replacement: "•••" };

let sessionKey = null; // AES key, held in memory only
let cache = null; // decrypted items for the current ciphertext, avoids re-decrypting per frame/page

async function getRecord() {
  return (await api.storage.local.get("vault")).vault || null;
}
async function getSettings() {
  const s = (await api.storage.local.get("settings")).settings || {};
  return { ...DEFAULT_SETTINGS, ...s };
}
// storage.session is memory-only and cleared when the browser closes. It lets the
// unlock survive the service worker being suspended, so the password is asked once.
async function persistKey(key) {
  sessionKey = key;
  cache = null;
  if (api.storage.session) {
    if (key) await api.storage.session.set({ jwk: await Vault.exportKey(key) });
    else await api.storage.session.remove("jwk");
  }
}
// "Locked" only hides the popup data (view/edit); hiding on pages keeps working with the in-memory key
// until the browser closes. storage.session is memory-only, so nothing extra is written to disk.
async function isLocked() {
  if (!api.storage.session) return false;
  return !!(await api.storage.session.get("locked")).locked;
}
async function setLocked(v) {
  if (!api.storage.session) return;
  if (v) await api.storage.session.set({ locked: true });
  else await api.storage.session.remove("locked");
}
async function loadKey() {
  if (sessionKey) return sessionKey;
  if (api.storage.session) {
    const { jwk } = await api.storage.session.get("jwk");
    if (jwk) sessionKey = await Vault.importKey(jwk);
  }
  return sessionKey;
}
const normHost = (h) => String(h).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^\*\./, "");
const hostMatches = (host, sites) => sites.some((s) => host === s || host.endsWith("." + s));
// Items are {name, text, sites, mode, replacement}. sites [] means every website; mode "" means the
// default action. Legacy plain strings are migrated.
function normItem(i) {
  const o = typeof i === "string" ? { text: i } : i || {};
  const sites = [...new Set((o.sites || []).map(normHost).filter(Boolean))];
  return {
    name: String(o.name ?? "").trim() || sites[0] || "",
    text: String(o.text ?? "").trim(),
    sites,
    mode: ["blur", "replace", "delete"].includes(o.mode) ? o.mode : "",
    replacement: String(o.replacement ?? "")
  };
}
function checked(i) {
  const n = normItem(i);
  if (!n.text) throw new Error("Enter the text to hide");
  if (!n.name) throw new Error("Give this item a name (needed when it applies to all sites)");
  return n;
}
function normItems(items) {
  const seen = new Set();
  return items.map(normItem).filter((i) => {
    if (!i.text) return false;
    const k = i.text + "\n" + i.sites.join(",") + "\n" + i.mode;
    return seen.has(k) ? false : seen.add(k);
  });
}
async function readItems() {
  const key = await loadKey();
  const record = await getRecord();
  if (!key || !record) return null;
  try {
    if (cache && cache.ct === record.ct && cache.iv === record.iv) return cache.items;
    const items = normItems(await Vault.decrypt(key, record));
    cache = { ct: record.ct, iv: record.iv, items };
    return items;
  } catch (e) {
    await persistKey(null);
    return null;
  }
}
async function writeItems(items) {
  const key = await loadKey();
  const record = await getRecord();
  if (!key || !record) throw new Error("locked");
  const { iv, ct } = await Vault.encrypt(key, normItems(items));
  await api.storage.local.set({ vault: { ...record, iv, ct } });
}
const needIndex = (items, index) => {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error("Not found");
  return index;
};
const needsUnlock = new Set(["getData", "addItem", "updateItem", "removeItem", "saveSettings"]);
const privileged = {
  async status() {
    return { initialized: !!(await getRecord()), unlocked: !(await isLocked()) && !!(await readItems()) };
  },
  async setup({ password }) {
    if (await getRecord()) throw new Error("Already set up");
    if (!password || password.length < MIN_PASSWORD) throw new Error(`Master password must be at least ${MIN_PASSWORD} characters`);
    const { key, record } = await Vault.create(password, []);
    await api.storage.local.set({ vault: record });
    await persistKey(key);
    await setLocked(false);
    return {};
  },
  async unlock({ password }) {
    const record = await getRecord();
    if (!record) throw new Error("Not set up");
    try {
      const { key } = await Vault.open(password, record);
      await persistKey(key);
      await setLocked(false);
    } catch (e) {
      throw new Error("Wrong master password");
    }
    return {};
  },
  async lock() {
    await setLocked(true);
    return {};
  },
  // The popup only gets masked entries (scope, no text) until a reveal with the master password.
  async getData() {
    const items = await readItems();
    if (!items) throw new Error("locked");
    return { items: items.map(({ name, sites, mode, replacement }) => ({ name, sites, mode, replacement })), settings: await getSettings() };
  },
  async addItem({ item }) {
    const items = await readItems();
    if (!items) throw new Error("locked");
    await writeItems([...items, checked(item)]);
    return {};
  },
  // Name, sites and action can be edited without the master password; the text itself is untouched.
  async updateItem({ index, name, sites, mode, replacement }) {
    const items = await readItems();
    if (!items) throw new Error("locked");
    needIndex(items, index);
    items[index] = checked({ ...items[index], name, sites, mode, replacement });
    await writeItems(items);
    return {};
  },
  async removeItem({ index }) {
    const items = await readItems();
    if (!items) throw new Error("locked");
    items.splice(needIndex(items, index), 1);
    await writeItems(items);
    return {};
  },
  async reveal({ index, password }) {
    const record = await getRecord();
    try { await Vault.open(password || "", record); } catch (e) { throw new Error("Wrong master password"); }
    const items = await readItems();
    if (!items) throw new Error("Not found");
    return { text: items[needIndex(items, index)].text };
  },
  // Forgotten master password: everything (texts, scopes, preferences) is erased.
  async reset() {
    await api.storage.local.remove(["vault", "settings"]);
    await persistKey(null);
    await setLocked(false);
    return {};
  },
  async saveSettings({ settings }) {
    const mode = settings && settings.mode;
    if (!["delete", "replace", "blur"].includes(mode)) throw new Error("Invalid mode");
    await api.storage.local.set({ settings: { mode, replacement: String(settings.replacement ?? "") } });
    return {};
  }
};

// Content scripts only get the list for the page's own host, and only if enabled and unlocked.
// The host comes from the browser-supplied sender URL, never from the message body.
async function forHost(msg, sender) {
  const settings = await getSettings();
  let h = "";
  try { h = new URL(sender.url).hostname.toLowerCase(); } catch (e) { /* no host: only all-sites items */ }
  const items = ((await readItems()) || []).filter((i) => !i.sites.length || hostMatches(h, i.sites))
    .map((i) => ({ text: i.text, mode: i.mode || settings.mode, replacement: i.replacement || settings.replacement }));
  if (!items.length) return { active: false };
  return { active: true, items };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  let task;
  if (sender.tab || sender.frameId) {
    task = msg.type === "forHost" ? forHost(msg, sender) : Promise.reject(new Error("Not allowed"));
  } else if (privileged[msg.type]) {
    task = needsUnlock.has(msg.type)
      ? isLocked().then((l) => { if (l) throw new Error("locked"); return privileged[msg.type](msg); })
      : privileged[msg.type](msg);
  } else {
    task = Promise.reject(new Error("Unknown message"));
  }
  task.then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
