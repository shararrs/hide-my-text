(() => {
  const api = globalThis.browser || globalThis.chrome;
  const MARK = "data-hmp";
  const ATTRS = ["placeholder", "title", "alt", "aria-label", "value"];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);
  let cfg, re;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function hideText(text) {
    return cfg.mode === "delete" ? "" : cfg.replacement;
  }

  function processTextNode(node) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType === 1 && (SKIP.has(parent.nodeName) || parent.hasAttribute(MARK))) return;
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    if (cfg.mode === "blur") {
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(text))) {
        frag.append(text.slice(last, m.index));
        const span = document.createElement("span");
        span.setAttribute(MARK, "1");
        span.style.setProperty("filter", "blur(6px)", "important");
        span.style.setProperty("user-select", "none", "important");
        span.textContent = m[0];
        frag.append(span);
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      parent.replaceChild(frag, node);
    } else {
      node.nodeValue = text.replace(re, () => hideText());
    }
  }

  function processElementAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      if (a === "value" && !/^(button|submit|reset)$/i.test(el.type || "") ) continue;
      const v = el.getAttribute(a);
      re.lastIndex = 0;
      if (re.test(v)) {
        re.lastIndex = 0;
        el.setAttribute(a, v.replace(re, () => (cfg.mode === "delete" ? "" : cfg.replacement)));
      }
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
    texts.forEach(processTextNode);
    els.forEach((el) => {
      processElementAttrs(el);
      if (el.shadowRoot) observe(el.shadowRoot);
      if (el.shadowRoot) scan(el.shadowRoot);
      if (/^i?frame$/i.test(el.nodeName)) {
        try {
          if (el.contentDocument) {
            observe(el.contentDocument);
            scan(el.contentDocument);
          }
        } catch (e) { /* cross-origin */ }
      }
    });
  }

  const observed = new WeakSet();
  let queue = new Set(), scheduled = false;
  function flush() {
    scheduled = false;
    const q = queue;
    queue = new Set();
    q.forEach((n) => n.isConnected && scan(n));
  }
  function enqueue(n) {
    queue.add(n);
    if (!scheduled) { scheduled = true; setTimeout(flush, 30); }
  }
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(enqueue);
      else if (m.type === "characterData") enqueue(m.target);
      else if (m.type === "attributes") enqueue(m.target);
    }
  });
  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function start() {
    observe(document);
    scan(document);
    // catches content added to iframes/shadow roots attached later
    setInterval(() => scan(document), 3000);
  }

  api.runtime.sendMessage({ type: "forHost", host: location.hostname }).then((res) => {
    if (!res || !res.ok || !res.active) return;
    cfg = res;
    const items = [...res.items].sort((a, b) => b.length - a.length).map(esc);
    re = new RegExp(items.join("|"), "gi");
    start();
  }).catch(() => {});
})();
