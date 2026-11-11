# Hide My Text - Architecture & Security Documentation

## Table of Contents

1. [Overview](#overview)
2. [Security Model](#security-model)
3. [Encryption Flow](#encryption-flow)
4. [Key Management](#key-management)
5. [Security Checklist](#security-checklist)
6. [Architecture Overview](#architecture-overview)

---

## Overview

**Hide My Text** is a browser extension designed to securely store and manage sensitive information (passwords, notes, API keys, etc.) with robust zero-knowledge architecture. The extension ensures that even if the local storage is compromised, the sensitive data remains encrypted and inaccessible without the master password.
```javascript
class VaultService {
  encrypt(data, password) => { /* AES-GCM with random IV */ }
  decrypt(encryptedData, password) => { /* PBKDF2 key derivation + AES */ }
}
```

---

## Security Model

### Zero-Knowledge Architecture

The extension implements a **zero-knowledge architecture**, meaning:

- ✅ **Master Password Never Stored** - The raw master password is used only during setup/login and immediately discarded
- ✅ **Derived Key in Memory Only** - Encryption key persists across browser sessions via `storage.session`, but is never written to disk
- ✅ **Client-Side Encryption** - All cryptography happens in the browser client; no data leaves the user's device

### Data Flow

``` txt
┌──────────────────────┐     ┌──────────────────────┐
│  User Enters Password │────▶│    PBKDF2            │
│                       │     │   Key Derivation      │
└──────────────────────┘     └────────┬──────────────┘
                                       │ Derived AES Key (in memory)
                                       ▼
┌─────────────────────┐     ┌────────────────────────────────┐
│  Vault (Encrypted)  │◀───▶│    AES-GCM Encryption          │
│  Stored in Local    │     │  with Random IV per Operation   │
│  Storage            │     └────────────────────────────────┘
└─────────────────────┘
```

### Security Guarantees

| Component | Protection Level | Implementation Details |
| --------- | ---------------- | ---------------------- |
| **At Rest** | HIGH | AES-GCM with random IV per session |
| **In Transit** | HIGH | Chrome extension messaging (HTTPS) |
| **Key Storage** | MEDIUM-HIGH | Session storage (volatile on browser restart) |
| **DOM Protection** | MEDIUM | Content scripts only run on specific pages; items not exposed to web context |

---

## Encryption Flow

### PBKDF2 Key Derivation

The master password is converted into a secure AES key using the PBKDF2 algorithm:

```javascript
// Key derivation process
const salt = generateRandomSalt(16); // 128-bit random salt
const iterations = parseInt(chrome.storage.session.get('iterations'), 10) || defaultIterations;

async function deriveKey(password, iterations) {
  return pbkdf2Sync(password, salt, { saltLength: 16, keyLength: 32, digest: 'sha512' });
}
```

**Parameters:**
- **Salt**: Randomly generated per session (prevents rainbow table attacks)
- **Iterations**: Configurable PBKDF2 rounds (higher = more secure but slower)
- **Output**: 256-bit AES key

### AES-GCM Encryption

Sensitive vault data is encrypted using the Galois/Counter Mode (GCM):

```javascript
// Encryption with random IV
function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  
  return aesGcmEncrypt({
    name: 'AES-GCM',
    key: key,
    iv: iv
  }).then(cipher => {
    return {
      ciphertext: cipher.data.byteLength.toString(),
      authenticationTag: cipher.tag.byteLength.toString()
    };
  });
}
```

**GCM Properties:**
- **IV**: Random 96-bit initialization vector per encryption
- **Cipher**: AES-256 in GCM mode (authenticated encryption)
- **Tag**: 128-bit authentication tag for integrity verification

### Decryption Process

When the user provides their master password:

```javascript
async function decrypt(encryptedData, password) {
  const key = deriveKey(password, iterations); // Re-derive key from password
  
  // Attempt decryption - throws if authentication fails (wrong password)
  return aesGcmDecrypt({
    name: 'AES-GCM',
    key: key,
    iv: parseIV(encryptedData.iv)
  });
}
```

### Security Considerations

1. **Perfect Forward Secrecy** - Wrong password = decryption throws immediately; no data leakage
2. **No Plaintext Password in Storage** - Only encrypted vault data is persisted
3. **Memory-Only Key Persistence** - Derived key exists only during active session

---

## Key Management

### Storage Strategy

The extension uses a hybrid storage approach:

``` txt
┌──────────┐     ┌──────────┐    ┌─────────────┐
│  Local   │     │ Session  │    └─────────────┘
│ Storage  │     │ Storage   │        Key Ring
└──────────┘◀────└──────────┘◀──────▶ Derived Keys
                      (volatile on restart)
```

### Key Lifecycle

| State | Storage Location | Purpose | Lifetime |
| ----- | ---------------- | ------- | -------- |
| **User Password** | Browser memory only | Input during login | Transient |
| **Derived AES Key** | Session Storage (`storage.session`) | Decryption helper across sessions | Browser restarts |
| **Vault Data** | Local Storage (Encrypted) | Persistent data storage | Persistent |

### Vault Structure

```javascript
// Example vault entry (encrypted payload)
{
  id: "uuid-v4",
  type: "item", // Note or password item
  name: "Example Item Name",
  encryptedData: { ... }, // AES-GCM encrypted content
  iv: "hex-encoded-iv-value"
}
```

## Security Checklist

✅ **Local Storage Encrypted** - Vault data is AES-GCM encrypted before persistence  
✅ **No Password in Local Storage** - Raw master password never persisted  
✅ **Derived Key in Memory Only** - Key exists in `storage.session` (volatile)  
✅ **Random IV Per Operation** - Fresh IV for every encryption prevents patterns  
✅ **MutationObserver Protection** - DOM changes detected and processed securely  

---

## Architecture Overview

The extension follows a modular architecture pattern typical of Chrome/Edge extensions:

### Key Components

1. **Background Script** (`background.js`)
   - Handles extension lifecycle events (install, update, message handling)
   - Manages communication between popup and content scripts
   - Stores derived encryption keys in session storage

2. **Content Scripts** (`content.js`)
   - Injected into all web pages by default
   - Monitor DOM changes via MutationObserver
   - Handle encrypted items display/editing logic

3. **Vault Service** (`vault.js`)
   - Core encryption/decryption logic
   - Provides API for vault operations (load, save, encrypt, decrypt)
   - Manages PBKDF2 key derivation and AES-GCM encryption

4. **Popup Page** (`popup.html` / `popup.js`)
   - User interface for accessing the password manager
   - Communication with background script via messaging