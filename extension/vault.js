// Encryption helpers: PBKDF2-SHA256 -> AES-256-GCM, using the WebCrypto API only.
(function (root) {
  const ITERATIONS = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (buf) => {
    let s = "";
    new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function deriveKey(password, salt, iterations = ITERATIONS) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  // A fresh random 96-bit IV is used for every encryption.
  async function encrypt(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  // Throws if the key is wrong or the data was tampered with (GCM auth tag).
  async function decrypt(key, blob) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return JSON.parse(dec.decode(pt));
  }

  async function create(password, data, iterations = ITERATIONS) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, iterations);
    return { key, record: { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), ...(await encrypt(key, data)) } };
  }

  async function open(password, record) {
    const key = await deriveKey(password, unb64(record.salt), record.iterations);
    return { key, data: await decrypt(key, record) };
  }

  const exportKey = (key) => crypto.subtle.exportKey("jwk", key);
  const importKey = (jwk) => crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);

  const api = { create, open, encrypt, decrypt, exportKey, importKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Vault = api;
})(typeof self !== "undefined" ? self : globalThis);
