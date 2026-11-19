(() => {
  const api = globalThis.browser || globalThis.chrome;
  const MARK = "data-hmp";
  const ATTRS = ["placeholder", "title", "alt", "aria-label", "value"];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);
  let re;
  const byText = new Map();

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const lookup = (m) => byText.get(m.toLowerCase()) || { mode: "delete", replacement: "" };

  function processTextNode(node) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType === 1 && (SKIP.has(parent.nodeName) || parent.hasAttribute(MARK))) return;
    const text = node.nodeValue;
    if (!text) return;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m, blurred = false;
    while ((m = re.exec(text))) {
      const it = lookup(m[0]);
      if (m.index > last) {
        frag.append(document.createTextNode(text.slice(last, m.index)));
      }
      if (it.mode === "blur") {
        blurred = true;
        const span = document.createElement("span");
        span.setAttribute(MARK, "1");
        span.style.setProperty("filter", "blur(6px)", "important");
        span.style.setProperty("user-select", "none", "important");
        span.textContent = m[0];
        frag.append(span);
      } else {
        const repl = it.mode === "delete" ? "" : it.replacement;
        if (repl) {
          frag.append(document.createTextNode(repl));
        }
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      frag.append(document.createTextNode(text.slice(last)));
    }
    // Pause the observer so our DOM changes don't re-trigger it
    observer.disconnect();
    try {
      if (blurred) {
        parent.replaceChild(frag, node);
      } else {
        node.nodeValue = frag.textContent;
      }
    } finally {
      // Re-attach to all previously observed roots
      observed.forEach((root) => _observe(root));
    }
  }

  function processElementAttrs(el) {
    // Skip elements we already processed (marked or inside a marked span)
    if (el.hasAttribute(MARK)) return;
    let changed = false;
    const updates = [];
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      if (a === "value" && !/^(button|submit|reset)$/i.test(el.type || "") ) continue;
      const v = el.getAttribute(a);
      re.lastIndex = 0;
      if (re.test(v)) {
        re.lastIndex = 0;
        const newV = v.replace(re, (m) => { const it = lookup(m); return it.mode === "delete" ? "" : it.replacement; });
        if (newV !== v) updates.push([a, newV]);
      }
    }
    if (!updates.length) return;
    // Pause the observer so setAttribute doesn't re-trigger it
    observer.disconnect();
    try {
      for (const [a, v] of updates) el.setAttribute(a, v);
    } finally {
      observed.forEach((root) => _observe(root));
    }
  }

  // Deep scan: every text node, open shadow roots, and same-origin iframes
  // (cross-origin frames run their own copy of this script via all_frames).
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) return processTextNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const texts = [];
    const els = root.nodeType === 1 ? [root] : [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === 3) texts.push(n);
      else els.push(n);
    }
    // Collect all text nodes first (before any DOM mutations), then process
    texts.forEach(processTextNode);
    els.forEach((el) => {
      processElementAttrs(el);
      if (el.shadowRoot) observe(el.shadowRoot);
      if (el.shadowRoot) scan(el.shadowRoot);
      if (/^i?frame$/i.test(el.nodeName)) {
        try {
          if (!hooked.has(el)) {
            hooked.add(el);
            el.addEventListener("load", () => enqueue(el));
          }
          if (el.contentDocument) {
            observe(el.contentDocument);
            scan(el.contentDocument);
          }
        } catch (e) { /* cross-origin */ }
      }
    });
  }

  const observed = new Set(), hooked = new WeakSet();
  let queue = new Set(), scheduled = false;
  function flush() {
    scheduled = false;
    const q = queue;
    queue = new Set();
    q.forEach((n) => {
      if (n.isConnected) {
        if (n.nodeType === 3) processTextNode(n);
        else scan(n);
      }
    });
  }
  function enqueue(n) {
    queue.add(n);
    if (!scheduled) { scheduled = true; setTimeout(flush, 30); }
  }

  // Internal observe that actually calls observer.observe (used when re-connecting)
  function _observe(root) {
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          // Don't re-process nodes we just inserted (marked spans or text in marked spans)
          if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(MARK)) return;
          if (n.parentNode && n.parentNode.nodeType === 1 && n.parentNode.hasAttribute && n.parentNode.hasAttribute(MARK)) return;
          enqueue(n);
        });
      } else if (m.type === "characterData") {
        // Don't re-process if inside a marked span
        const p = m.target.parentNode;
        if (p && p.nodeType === 1 && p.hasAttribute && p.hasAttribute(MARK)) return;
        enqueue(m.target);
      } else if (m.type === "attributes") {
        // Don't re-process marked elements (we set those attrs ourselves)
        if (m.target.hasAttribute && m.target.hasAttribute(MARK)) return;
        enqueue(m.target);
      }
    }
  });

  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    _observe(root);
  }

  function start() {
    observe(document);
    scan(document);
  }

  api.runtime.sendMessage({ type: "forHost" }).then((res) => {
    if (!res || !res.ok || !res.active) return;
    res.items.forEach((it) => { if (!byText.has(it.text.toLowerCase())) byText.set(it.text.toLowerCase(), it); });
    const items = [...byText.keys()].sort((a, b) => b.length - a.length).map(esc);
    re = new RegExp(items.join("|"), "gi");
    // A replacement that itself matches a hidden text would be re-replaced forever by the observer.
    byText.forEach((it) => { re.lastIndex = 0; if (it.mode === "replace" && re.test(it.replacement)) it.replacement = ""; });
    re.lastIndex = 0;
    start();
  }).catch(() => {});
})();
