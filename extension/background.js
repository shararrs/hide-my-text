/* global Vault */
if (typeof importScripts === "function") importScripts("vault.js");

const api = globalThis.browser || globalThis.chrome;
const MIN_PASSWORD = 8;
const DEFAULT_SETTINGS = { mode: "blur", replacement: "•••", sites: [] };

let sessionKey = null; // AES key, held in memory only

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
  if (api.storage.session) {
    if (key) await api.storage.session.set({ jwk: await Vault.exportKey(key) });
    else await api.storage.session.remove("jwk");
  }
}
async function loadKey() {
  if (sessionKey) return sessionKey;
  if (api.storage.session) {
    const { jwk } = await api.storage.session.get("jwk");
    if (jwk) sessionKey = await Vault.importKey(jwk);
  }
  return sessionKey;
}
async function readItems() {
  const key = await loadKey();
  const record = await getRecord();
  if (!key || !record) return null;
  try {
    return await Vault.decrypt(key, record);
  } catch (e) {
    await persistKey(null);
    return null;
  }
}
async function writeItems(items) {
  const key = await loadKey();
  const record = await getRecord();
  if (!key || !record) throw new Error("locked");
  const clean = items.map((t) => String(t).trim()).filter(Boolean);
  const { iv, ct } = await Vault.encrypt(key, [...new Set(clean)]);
  await api.storage.local.set({ vault: { ...record, iv, ct } });
}
const normHost = (h) => String(h).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^\*\./, "");
const hostMatches = (host, sites) => sites.some((s) => host === s || host.endsWith("." + s));

const privileged = {
  async status() {
    return { initialized: !!(await getRecord()), unlocked: !!(await readItems()) };
  },
  async setup({ password }) {
    if (await getRecord()) throw new Error("Already set up");
    if (!password || password.length < MIN_PASSWORD) throw new Error(`Master password must be at least ${MIN_PASSWORD} characters`);
    const { key, record } = await Vault.create(password, []);
    await api.storage.local.set({ vault: record });
    await persistKey(key);
    return {};
  },
  async unlock({ password }) {
    const record = await getRecord();
    if (!record) throw new Error("Not set up");
    try {
      const { key } = await Vault.open(password, record);
      await persistKey(key);
    } catch (e) {
      throw new Error("Wrong master password");
    }
    return {};
  },
  async lock() {
    await persistKey(null);
    return {};
  },
  async getData() {
    const items = await readItems();
    if (!items) throw new Error("locked");
    return { items, settings: await getSettings() };
  },
  async saveItems({ items }) {
    await writeItems(items);
    return {};
  },
  async saveSettings({ settings }) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    if (!["delete", "replace", "blur"].includes(s.mode)) throw new Error("Invalid mode");
    s.replacement = String(s.replacement ?? "");
    s.sites = [...new Set((s.sites || []).map(normHost).filter(Boolean))];
    await api.storage.local.set({ settings: s });
    return {};
  }
};

// Content scripts only get the list for the page's own host, and only if enabled and unlocked.
async function forHost({ host }) {
  const settings = await getSettings();
  if (!hostMatches(String(host).toLowerCase(), settings.sites)) return { active: false };
  const items = await readItems();
  if (!items || !items.length) return { active: false };
  return { active: true, items, mode: settings.mode, replacement: settings.replacement };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  let task;
  if (sender.tab || sender.frameId) {
    task = msg.type === "forHost" ? forHost(msg) : Promise.reject(new Error("Not allowed"));
  } else if (privileged[msg.type]) {
    task = privileged[msg.type](msg);
  } else {
    task = Promise.reject(new Error("Unknown message"));
  }
  task.then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
