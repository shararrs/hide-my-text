# Hide My Pass

A browser extension (Manifest V3) that hides texts you choose on websites you choose. Each match can be **blurred**, **replaced** with a string, or **deleted**. Works in Chrome, Edge and Firefox.

## Usage
1. Click the extension icon. On first start you only choose a **master password** (no username, min 8 characters, not recoverable).
2. Add the texts to hide, and the websites on which the extension should be active (`example.com` also covers `www.example.com` and other subdomains). Pick the action (blur / replace / delete).
3. The page reloads and the texts are hidden. After a restart of the browser you are asked for the master password once; it stays unlocked until the browser closes or you press **Lock**.

On any site that is not in your list the extension does nothing. While locked, nothing is hidden.

## Deep text search
The content script runs in every frame (`all_frames`) and scans all text nodes (including hidden elements, popups, closed accordions), open shadow roots, same-origin iframes, and the `placeholder`, `title`, `alt`, `aria-label` attributes and button values. A `MutationObserver` re-scans anything added later (paginated content, modals, infinite scroll) plus a periodic re-scan. Matching is case-insensitive.

## How texts are stored and encrypted
- **Key derivation:** master password → **PBKDF2-HMAC-SHA-256**, 600,000 iterations, random 16-byte salt → 256-bit key.
- **Encryption:** **AES-256-GCM** (WebCrypto `crypto.subtle`), random 96-bit IV generated for every save. GCM authenticates the data, so a wrong password or tampering fails to decrypt.
- **Storage:** `storage.local` holds only `{salt, iterations, iv, ciphertext}`. The master password is never stored; the list of texts is never stored in plaintext.
- **Unlock state:** the derived key (not the password) is kept in the background worker's memory and in `storage.session` (memory only, cleared when the browser closes) so the password is asked only once.
- **Not secret:** the site list, action and replacement string are stored unencrypted in `storage.local`.
- **Access control:** content scripts can only ask for the list for their own page host and only receive it if that host is enabled; the page itself has no access. Only the popup can read/modify the full data.
- Code: `extension/vault.js` (crypto), `extension/background.js` (storage/session), `extension/content.js` (hiding).

Limitation: texts handed to the content script exist in page-script-inaccessible extension memory, but anyone with access to your unlocked browser profile can open the popup. Lock when away.

## Install (unpacked / developer mode)
Download or clone this repo; the extension is the `extension/` folder.

### Chrome
1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

### Microsoft Edge
1. Open `edge://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

### Firefox (115+)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `extension/manifest.json` (removed when Firefox restarts; for permanent install, zip the folder contents and sign it via addons.mozilla.org).
3. Firefox treats `<all_urls>` host access as optional: if the extension does nothing, open `about:addons` → Hide My Pass → Permissions and allow access to all sites.

## Tests
`node --test tests/vault.test.js` (Node 18+).
