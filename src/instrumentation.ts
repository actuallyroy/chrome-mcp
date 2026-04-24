// Browser-side instrumentation injected into every page. Exposes `window.__mcp`
// with semantic helpers the tools use (findByText/Label/Ref, outline, toasts).
// Written as a single IIFE so it can be injected via evaluateOnNewDocument
// and also re-run idempotently from evaluate().

export const INSTRUMENTATION_SCRIPT = `
(() => {
  if (window.__mcp && window.__mcp.__installed) return;

  const INTERACTIVE_ROLES = new Set([
    'button','link','menuitem','option','tab','checkbox','radio','switch','textbox','combobox','searchbox','spinbutton','slider'
  ]);
  const INPUT_TAGS = new Set(['INPUT','TEXTAREA','SELECT']);

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  }

  function visibleText(el) {
    if (!el) return '';
    // Avoid getting concatenated text of huge subtrees
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }

  function elRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return 'heading';
    return '';
  }

  function labelFor(el) {
    // aria-label wins
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return al.trim();
    // aria-labelledby
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean);
      if (parts.length) return parts.map(p => p.textContent.trim()).join(' ').trim();
    }
    // <label for=id>
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return lbl.textContent.replace(/\\*/g,'').trim();
    }
    // ancestor <label>
    let p = el.parentElement;
    while (p) {
      if (p.tagName === 'LABEL') return p.textContent.replace(/\\*/g,'').trim();
      p = p.parentElement;
    }
    // Preceding sibling label text (common in shadcn forms: <div><Label/>…<input/></div>)
    let container = el.closest('[class],div');
    if (container) {
      const sib = container.querySelector('label, [role="label"]');
      if (sib) return sib.textContent.replace(/\\*/g,'').trim();
    }
    // placeholder as fallback
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph.replace(/\\*/g,'').trim();
    return '';
  }

  function interactiveElements() {
    const sel = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="slider"]';
    return [...document.querySelectorAll(sel)].filter(isVisible);
  }

  function findByText(text, roleHint) {
    const target = text.trim();
    const els = interactiveElements();
    // Prefer exact visibleText matches
    const exact = els.filter(e => {
      const t = (e.innerText || e.textContent || '').trim();
      return t === target || (e.getAttribute('aria-label') || '').trim() === target;
    });
    if (roleHint) {
      const byRole = exact.filter(e => elRole(e) === roleHint);
      if (byRole.length) return byRole[0];
    }
    if (exact.length) return exact[0];
    // Contains match, still on interactive els only
    const partial = els.filter(e => (e.innerText || '').trim().includes(target));
    return partial[0] || null;
  }

  function findByLabel(label) {
    const target = label.replace(/\\*/g,'').trim().toLowerCase();
    // Native <label for=>
    for (const lbl of document.querySelectorAll('label')) {
      const t = lbl.textContent.replace(/\\*/g,'').trim().toLowerCase();
      if (t === target) {
        if (lbl.htmlFor) {
          const e = document.getElementById(lbl.htmlFor);
          if (e && isVisible(e)) return e;
        }
        const nested = lbl.querySelector('input, textarea, select, [role="combobox"], [role="textbox"]');
        if (nested && isVisible(nested)) return nested;
      }
    }
    // shadcn/radix: sibling or cousin input after a label-like element
    const labelEls = [...document.querySelectorAll('label, [data-slot="label"], [role="label"]')];
    for (const lbl of labelEls) {
      const t = lbl.textContent.replace(/\\*/g,'').trim().toLowerCase();
      if (t !== target) continue;
      // Look forward in DOM order within the same form-ish container
      const container = lbl.closest('form, fieldset, [data-slot="form-item"], div');
      if (container) {
        const candidates = container.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"], [role="switch"], [role="checkbox"]');
        for (const c of candidates) {
          if (isVisible(c) && c !== lbl && lbl.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) return c;
        }
      }
    }
    // aria-label fallback
    for (const e of interactiveElements()) {
      const al = (e.getAttribute('aria-label') || '').replace(/\\*/g,'').trim().toLowerCase();
      if (al === target) return e;
    }
    // placeholder fallback
    for (const e of document.querySelectorAll('input, textarea')) {
      const ph = (e.placeholder || '').replace(/\\*/g,'').trim().toLowerCase();
      if (ph === target && isVisible(e)) return e;
    }
    return null;
  }

  function findByRef(n) {
    return document.querySelector('[data-mcp-ref="' + String(n) + '"]');
  }

  function fieldDescriptor(el, ref) {
    const role = elRole(el);
    const lbl = labelFor(el);
    const required = el.required || el.getAttribute('aria-required') === 'true' || el.getAttribute('required') !== null;
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    let value = '';
    if (INPUT_TAGS.has(el.tagName)) value = el.value || '';
    else if (role === 'combobox') value = (el.textContent || '').trim();
    else if (role === 'switch' || role === 'checkbox' || role === 'radio') value = (el.checked || el.getAttribute('aria-checked') === 'true') ? 'on' : 'off';
    if (value && value.length > 60) value = value.slice(0,60) + '…';
    const tag = '[' + role + ' #' + ref + (required ? ' required' : '') + (disabled ? ' disabled' : '') + ']';
    const name = lbl || visibleText(el) || '';
    const val = (role !== 'button' && role !== 'link') && value ? ' = "' + value + '"' : '';
    return tag + '  ' + name + val;
  }

  function outline() {
    // Assign refs to every interactive element. Refs are stable across outlines —
    // we only hand out NEW numbers to elements that don't already have one.
    const els = interactiveElements();
    if (typeof window.__mcp.__nextRef !== 'number') window.__mcp.__nextRef = 1;
    for (const el of els) {
      if (!el.getAttribute('data-mcp-ref')) {
        el.setAttribute('data-mcp-ref', String(window.__mcp.__nextRef++));
      }
    }

    const lines = [];
    lines.push('URL: ' + location.href);
    lines.push('TITLE: ' + document.title);
    const h1 = document.querySelector('h1, [role="heading"][aria-level="1"]');
    if (h1) lines.push('H1: ' + visibleText(h1));
    lines.push('');

    // Group by nearest heading (h2/h3). Walk the DOM in order.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let currentSection = '';
    let node;
    const sectionToLines = new Map();
    sectionToLines.set('', []);
    while ((node = walker.nextNode())) {
      if (!isVisible(node)) continue;
      if (/^H[2-4]$/.test(node.tagName) || (node.getAttribute('role') === 'heading' && ['2','3','4'].includes(node.getAttribute('aria-level')))) {
        currentSection = visibleText(node);
        if (!sectionToLines.has(currentSection)) sectionToLines.set(currentSection, []);
        continue;
      }
      const ref = node.getAttribute('data-mcp-ref');
      if (ref) {
        const desc = fieldDescriptor(node, ref);
        if (desc) {
          if (!sectionToLines.has(currentSection)) sectionToLines.set(currentSection, []);
          sectionToLines.get(currentSection).push(desc);
        }
      }
    }
    for (const [section, sectionLines] of sectionToLines) {
      if (sectionLines.length === 0) continue;
      if (section) lines.push('SECTION: ' + section);
      for (const l of sectionLines) lines.push('  ' + l);
      lines.push('');
    }

    // Append recent toasts
    if (window.__mcp.toasts.length) {
      lines.push('TOASTS (captured, newest first):');
      for (const t of [...window.__mcp.toasts].reverse().slice(0,5)) {
        lines.push('  - ' + t.text);
      }
      lines.push('');
    }

    return lines.join('\\n');
  }

  function describeElement(el) {
    if (!el) return null;
    const attrs = {};
    for (const a of el.attributes || []) {
      if (a.name === 'class' || a.name === 'style') continue;
      if (String(a.value).length > 80) attrs[a.name] = String(a.value).slice(0,80) + '…';
      else attrs[a.name] = a.value;
    }
    const parents = [];
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 5) {
      const label = p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.getAttribute('role') ? '[role=' + p.getAttribute('role') + ']' : '');
      parents.push(label);
      p = p.parentElement;
      depth++;
    }
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: elRole(el),
      label: labelFor(el),
      ref: el.getAttribute('data-mcp-ref') || null,
      text: visibleText(el),
      visible: isVisible(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      attrs,
      ancestors: parents,
    };
  }

  function installConsoleCapture() {
    if (window.__mcp._consoleInstalled) return;
    window.__mcp.console = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = console[level].bind(console);
      console[level] = function(...args) {
        try {
          const text = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          }).join(' ');
          window.__mcp.console.push({ ts: Date.now(), level, text: text.slice(0, 2000) });
          if (window.__mcp.console.length > 500) window.__mcp.console.shift();
        } catch {}
        return orig(...args);
      };
    }
    // Unhandled errors and rejections.
    window.addEventListener('error', (e) => {
      window.__mcp.console.push({ ts: Date.now(), level: 'error', text: '[window.error] ' + (e.message || String(e.error || e)) });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__mcp.console.push({ ts: Date.now(), level: 'error', text: '[unhandledrejection] ' + (e.reason?.message || String(e.reason)) });
    });
    window.__mcp._consoleInstalled = true;
  }

  function installNetworkCapture() {
    if (window.__mcp._networkInstalled) return;
    window.__mcp.network = [];
    const push = (entry) => {
      window.__mcp.network.push(entry);
      if (window.__mcp.network.length > 500) window.__mcp.network.shift();
    };
    // fetch
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      const entry = { ts: Date.now(), kind: 'fetch', method, url: String(url), status: null, ms: null, error: null };
      const t0 = performance.now();
      push(entry);
      try {
        const res = await origFetch.apply(this, args);
        entry.status = res.status;
        entry.ms = Math.round(performance.now() - t0);
        return res;
      } catch (e) {
        entry.error = (e && e.message) || String(e);
        entry.ms = Math.round(performance.now() - t0);
        throw e;
      }
    };
    // XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__mcp = { method, url: String(url) };
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const entry = { ts: Date.now(), kind: 'xhr', method: this.__mcp?.method || 'GET', url: this.__mcp?.url || '', status: null, ms: null, error: null };
      const t0 = performance.now();
      push(entry);
      this.addEventListener('loadend', () => {
        entry.status = this.status;
        entry.ms = Math.round(performance.now() - t0);
      });
      this.addEventListener('error', () => { entry.error = 'xhr error'; });
      return origSend.apply(this, args);
    };
    window.__mcp._networkInstalled = true;
  }

  function showPauseOverlay(message) {
    // Remove any existing overlay first
    const old = document.getElementById('__mcp_pause_overlay');
    if (old) old.remove();
    window.__mcp.paused = true;
    const overlay = document.createElement('div');
    overlay.id = '__mcp_pause_overlay';
    overlay.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#111;color:#fff;padding:14px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);font:13px/1.4 -apple-system,system-ui,sans-serif;max-width:360px;display:flex;gap:12px;align-items:flex-start;';
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:4px;';
    title.textContent = 'Agent paused';
    const msg = document.createElement('div');
    msg.style.cssText = 'opacity:.8;white-space:pre-wrap;';
    msg.textContent = message || 'Click Resume when ready.';
    body.append(title, msg);
    const btn = document.createElement('button');
    btn.textContent = 'Resume';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;';
    btn.onclick = () => { window.__mcp.paused = false; overlay.remove(); };
    overlay.append(body, btn);
    document.body.appendChild(overlay);
  }

  function installToastWatcher() {
    if (window.__mcp._toastObs) return;
    window.__mcp.toasts = [];
    const extract = (el) => {
      if (!(el instanceof Element)) return null;
      // sonner
      if (el.matches && el.matches('li[data-sonner-toast]')) return el.textContent.trim();
      // role=alert / role=status (radix toast, etc.)
      if (el.matches && (el.matches('[role="alert"]') || el.matches('[role="status"]'))) {
        const t = el.textContent.trim();
        if (t && t.length < 400) return t;
      }
      // nested
      const nested = el.querySelector && el.querySelector('li[data-sonner-toast], [role="alert"]');
      if (nested) return nested.textContent.trim();
      return null;
    };
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const t = extract(n);
          if (t && t.length > 2) window.__mcp.toasts.push({ts: Date.now(), text: t});
        }
      }
    });
    obs.observe(document.body, {childList: true, subtree: true});
    window.__mcp._toastObs = obs;
  }

  window.__mcp = {
    __installed: true,
    toasts: [],
    console: [],
    network: [],
    paused: false,
    findByText,
    findByLabel,
    findByRef,
    describeElement,
    outline,
    installToastWatcher,
    installConsoleCapture,
    installNetworkCapture,
    showPauseOverlay,
  };

  // Network and console need to be installed before any user code runs.
  installConsoleCapture();
  installNetworkCapture();
  // Toast watcher needs body to exist.
  if (document.body) installToastWatcher();
  else document.addEventListener('DOMContentLoaded', installToastWatcher, { once: true });
})();
`;
