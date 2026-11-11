# Hide My Text – Codebase Guide

A file-by-file walkthrough: what each file contains, how the extension starts, and which file calls which.

## 1. File map

```
extension/
  manifest.json   Declares permissions, entry points and where scripts are injected
  vault.js        Crypto only (PBKDF2 -> AES-GCM). No browser-extension APIs
  background.js   Service worker / event page: owns the key, storage and all data rules
  content.js      Injected into every page/frame: finds and hides the texts
  popup.html      Popup markup + CSS
  popup.js        Popup logic (UI only, talks to background.js)
tests/
  vault.test.js   Node tests for vault.js
docs/
  ARCHITECTURE.md Older overview (see §8 for inaccuracies)
  CODEBASE_GUIDE.md  This file
```

There is no build step and no third-party dependency; the `extension/` folder is loaded as-is.

## 2. How the app starts

Three independent entry points are declared in [manifest.json](../extension/manifest.json):

| Entry point | Starts when | File(s) |
| --- | --- | --- |
| Background | Browser starts / extension loads; the worker is woken by messages | `vault.js` + `background.js` |
| Content script | Every page and every frame load (`<all_urls>`, `all_frames`, `match_about_blank`, `document_start`) | `content.js` |
| Popup | User clicks the toolbar icon | `popup.html` -> `popup.js` |

Startup sequence in practice:

1. **Background loads.** In Chrome the service worker runs `importScripts("vault.js")` (first line of `background.js`); in Firefox the `scripts` array loads `vault.js` first. `vault.js` registers a global `Vault`. `background.js` then registers one `runtime.onMessage` listener and does nothing else until a message arrives. The in-memory key (`sessionKey`) starts as `null`; it is lazily restored from `storage.session` by `loadKey()`.
2. **A page loads.** `content.js` runs at `document_start`, sends `{type:"forHost"}` to the background, and, if the response lists items, builds one regex and starts scanning (section 5).
3. **The user opens the popup.** `popup.js` calls `refresh()` -> `status` message. Depending on the answer it shows the auth card (create/unlock) or the main card (add/list/edit items).

All communication between the three parts is `runtime.sendMessage` request/response; the contract is `{ok:true, ...data}` or `{ok:false, error}`.

## 3. Call graph

```
 web page (any frame)                         toolbar popup
 ┌────────────┐                               ┌───────────────┐
 │ content.js │                               │ popup.html    │
 └─────┬──────┘                               │   └ popup.js  │
       │ {type:"forHost"}                     └──────┬────────┘
       │                                             │ status / setup / unlock / lock /
       │                                             │ getData / addItem / updateItem /
       │                                             │ removeItem / reveal / reset / saveSettings
       ▼                                             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ background.js  onMessage listener                           │
 │   sender has tab/frameId -> only "forHost" allowed          │
 │   otherwise              -> `privileged` handlers           │
 └───────┬───────────────────────────────┬─────────────────────┘
         │ Vault.create/open/encrypt/    │ storage.local  (vault record, settings)
         │ decrypt/exportKey/importKey   │ storage.session (jwk, locked flag)
         ▼                               ▼
     vault.js                       browser storage
```

`vault.js`, `content.js`, and `popup.js` never call each other directly. `popup.js` additionally calls `tabs.query` / `tabs.reload` to read the active tab's host and refresh it after changes.

## 4. File details

### 4.1 [manifest.json](../extension/manifest.json)

- Manifest V3, version 1.0.0.
- `permissions: ["storage"]`; `host_permissions: ["<all_urls>"]` (needed to inject the content script and read the active tab URL; no `tabs` or `activeTab`).
- `background` declares both `service_worker` (Chrome) and `scripts` (Firefox).
- `action.default_popup` -> `popup.html`.
- One content-script block (see §2). No `web_accessible_resources`, so web pages cannot load extension files.
- No custom CSP: the MV3 default (`script-src 'self'`) applies, which is why `popup.html` has no inline scripts.
- `browser_specific_settings.gecko` sets the Firefox add-on ID (currently a placeholder `@shararrs.example`).

### 4.2 [vault.js](../extension/vault.js) – crypto

Single IIFE exporting `Vault` (global in the browser, `module.exports` in Node for tests). Uses only `crypto.subtle`.

| Function | Purpose |
| --- | --- |
| `deriveKey(password, salt, iterations)` | PBKDF2-SHA-256 (default 600,000 iterations) -> AES-256-GCM key. Rejects iteration counts that are not integers in 1..10,000,000. Key is *extractable* so it can be saved to `storage.session`. |
| `encrypt(key, data)` | JSON-encodes `data`, encrypts with a fresh random 96-bit IV -> `{iv, ct}` (base64). |
| `decrypt(key, blob)` | AES-GCM decrypt + JSON parse; throws on wrong key or tampering. |
| `create(password, data, iterations)` | New random 16-byte salt; returns `{key, record}` where `record = {v:1, kdf, iterations, salt, iv, ct}`. |
| `open(password, record)` | Derives the key from the record's salt/iterations and decrypts -> `{key, data}`. |
| `exportKey` / `importKey` | JWK round-trip, used to persist the unlocked key in `storage.session`. |

Called only by `background.js` (and `tests/vault.test.js`).

### 4.3 [background.js](../extension/background.js) – the core

**State**
- `sessionKey` (memory) – AES key once unlocked. Restored from `storage.session.jwk` after the worker is suspended.
- `cache` – decrypted items for the current ciphertext (avoids decrypting for every frame).
- `storage.local.vault` – the encrypted record. `storage.local.settings` – `{mode, replacement}` default action (plaintext).
- `storage.session.jwk` / `.locked` – memory-only; cleared when the browser closes.

**Helpers**: `getRecord`, `getSettings`, `persistKey`, `isLocked`/`setLocked`, `loadKey`, `normHost`, `hostMatches`, `normItem`/`checked`/`normItems` (validate, trim, dedupe, migrate legacy string items), `readItems` (decrypt + cache; on failure forgets the key), `writeItems` (re-encrypt with a new IV), `needIndex` (integer bounds check on item indexes).

**Item shape** (inside the encrypted blob): `{name, text, sites[], mode, replacement}`; `sites: []` means all sites; `mode: ""` means "use the default action".

**`privileged` handlers** (popup only):

| Message | Effect |
| --- | --- |
| `status` | `{initialized, unlocked}` |
| `setup` | First run: password >= 8 chars, creates empty vault, unlocks |
| `unlock` | Derives key from password, stores it, clears the locked flag |
| `lock` | Sets the locked flag (popup data hidden; on-page hiding keeps working) |
| `getData` | Items **without text** + settings |
| `addItem` / `updateItem` / `removeItem` | Mutate the list (need unlocked popup). `updateItem` never touches `text` |
| `reveal` | Re-verifies the master password, returns one item's text |
| `reset` | Deletes vault + settings (forgot-password path) |
| `saveSettings` | Saves default mode/replacement (whitelisted fields only) |

`needsUnlock` makes the data-touching ones fail with `"locked"` when the popup is locked.

**`forHost`** (content scripts only): derives the host from the browser-provided `sender.url`, filters items by `hostMatches` (exact host or any subdomain), resolves each item's mode/replacement against the defaults, and returns `{active, items:[{text, mode, replacement}]}`.

**Message router** (bottom of file): ignores messages from other extensions (`sender.id`), treats any sender with `tab`/`frameId` as a content script (only `forHost` allowed), everything else as the popup.

### 4.4 [content.js](../extension/content.js) – hiding on the page

Wrapped in an IIFE; runs in the extension's isolated world (page scripts cannot read its variables).

1. Sends `forHost`; on `{active:true}` fills `byText` (lower-cased text -> item) and builds a single case-insensitive regex of escaped texts, longest first. A replacement that would itself match a hidden text is neutralised to `""` (prevents an endless rewrite loop).
2. `scan(root)` walks all text nodes and elements (`TreeWalker`), then handles open shadow roots and same-origin iframes (cross-origin frames run their own content script).
3. `processTextNode`: delete / replace edit the text; blur wraps the match in `<span data-hmp>` with `filter: blur(6px)`. Replacement strings are inserted as text nodes, never HTML. `SCRIPT, STYLE, NOSCRIPT, TEXTAREA, TEMPLATE` and already-marked spans are skipped.
4. `processElementAttrs`: handles `placeholder, title, alt, aria-label` and `value` of button-like inputs (blur is downgraded to replace in attributes).
5. A `MutationObserver` (+ iframe `load` listeners) queues changed nodes and rescans them after 30 ms (`enqueue` -> `flush`). No polling.

Calls out to: `background.js` via `runtime.sendMessage` only.

### 4.5 [popup.html](../extension/popup.html)

Static markup and inline `<style>` (light/dark via CSS variables, `data-theme` attribute). Sections:
- `#auth` – master password inputs, Unlock/Create button, "Forgot master password?" link.
- `#main` – "Add text to hide" form (name, text as a password field, scope radio, sites, action, replacement), "Hidden texts" list `#items`, default-action card, Lock button.
- `#modal` – in-page password/confirm dialog (replaces `prompt`/`confirm`).
- `#err` – error line. Loads only `popup.js` (`<script src>`).

### 4.6 [popup.js](../extension/popup.js)

- `call(msg)` – wrapper over `runtime.sendMessage`; throws on `{ok:false}`. `guard(fn)` – shows errors in `#err`.
- `refresh()` – the main loop: `status` -> show auth or main; on unlocked `getData` -> `render()`.
- `renderItems()` / `editor()` – build the list with DOM APIs (`textContent`, never `innerHTML`, so item names/sites cannot inject markup). 👁 asks the master password through `ask()`, calls `reveal`, shows the text for 10 s. ⚙ opens the inline editor (`updateItem`). ✕ calls `removeItem`.
- Handlers: `authBtn` (`setup`/`unlock`), `forgot` (`reset`), `addText` (`addItem`), `mode`/`replacement` (`saveSettings`), `lock`.
- After every mutation it calls `reloadTab()` so the content script re-fetches the list.
- Theme preference is the only thing in the popup's `localStorage`.

### 4.7 [tests/vault.test.js](../tests/vault.test.js)

Run with `node --test tests/vault.test.js`. Covers round trip + no plaintext in the record, wrong password/tamper rejection, and rejection of out-of-range iteration counts. `background.js`, `content.js` and `popup.js` have no automated tests.

## 5. Typical flows

**First use:** popup `refresh` -> `status` (`initialized:false`) -> user submits -> `setup` -> `Vault.create` -> record saved to `storage.local`, key saved to `storage.session` -> `getData` -> main view.

**Add an item:** `addItem` -> `readItems` (decrypt) -> `checked` -> `writeItems` (new IV) -> popup `refresh` + tab reload -> page's content script sends `forHost` -> background decrypts (cache) and returns matching items -> `scan`.

**Browser restart:** `storage.session` is wiped, so `status` returns `unlocked:false`; the user enters the password once (`unlock`). Until then nothing is hidden on pages.

## 6. Security review (current code)

### Fixed in this pass
| Issue | Fix |
| --- | --- |
| `forHost` trusted a host string sent by the content script | Host now comes from `sender.url` (browser-provided) |
| `removeItem`/`updateItem`/`reveal` accepted any `index` (`splice(undefined)`/negative removed the wrong entry) | `needIndex` requires an in-range integer |
| `saveSettings` stored arbitrary extra keys | Only `mode` and `replacement` are stored |
| Vault `iterations` read from storage unchecked (hang on huge values) | Bounded to 1..10,000,000, with a test |
| A replacement containing a hidden text caused an infinite rewrite loop in the page | Such replacements are replaced with an empty string |

### Verified good
- Password is never stored; only the derived key is kept in memory / `storage.session` (not readable by content scripts).
- AES-GCM with a fresh random IV per write; PBKDF2-SHA-256 600k iterations; GCM detects tampering.
- Content scripts can only call `forHost`; popup actions are rejected from them. Messages from other extensions are dropped.
- No `innerHTML`, `eval`, or remote code; replacement text is inserted as text; the regex is escaped.
- Minimal permissions; no `web_accessible_resources`; no network calls.

### Residual risks / design limitations (not changed)
1. **Oracle by hostile pages.** A page can insert guesses into its own DOM and see whether they get replaced/blurred, which lets it brute-force items scoped to "all sites". Prefer *Specific sites* for sensitive texts.
2. **Blur is cosmetic.** Blurred text remains in the DOM and is readable by page scripts.
3. **Unlocked until the browser closes.** The key stays in `storage.session`; "Lock" only hides popup data. There is no idle timeout. Consider adding one.
4. **`reset` needs no password** (intended forgot-password flow, but anyone with the popup can wipe the vault).
5. **No unlock rate limiting.** Irrelevant to offline attacks, which PBKDF2 cost covers; strength depends on the master password (only an 8-character minimum is enforced).
6. **Extractable key** is required to persist it in `storage.session`.
7. Wide `<all_urls>` + `all_frames` access is inherent to the feature. The default action and replacement string are stored unencrypted.
8. Read-modify-write on the item list is not serialised; rapid concurrent edits from one popup could lose an update.

## 7. Where to change things

| Want to... | Edit |
| --- | --- |
| Change KDF cost / algorithm | `vault.js` (`ITERATIONS`; old records keep their stored count) |
| Change what pages are told | `forHost` in `background.js` |
| Add a popup action | handler in `privileged` (+ `needsUnlock`) and a `call(...)` in `popup.js` |
| Change how text is hidden | `processTextNode` / `processElementAttrs` in `content.js` |
| Restrict where it runs | `content_scripts.matches` in `manifest.json` |

## 8. Known inaccuracies in `ARCHITECTURE.md`

`ARCHITECTURE.md` is a high-level draft and does not match the code in several places; rely on this guide and the README:
- Shows a `VaultService` class and `sha512` / `pbkdf2Sync` / `storage.session iterations` snippets; the real code is `Vault` in `vault.js` using WebCrypto PBKDF2-SHA-256 with iterations stored in the vault record.
- States salt is "per session"; it is generated once per vault at creation.
- Claims "HTTPS" for extension messaging (it is internal browser IPC) and "Perfect Forward Secrecy" (not applicable).
- Says the key is "never written to disk"/"memory only" while also describing `storage.session`; it is memory-only but persisted for the browser session.
- The vault structure example (`id`, `type`, `encryptedData`) does not exist; the real record is `{v, kdf, iterations, salt, iv, ct}`.
- Says content scripts run "on specific pages"; they run on all pages and frames.
