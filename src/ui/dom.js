// Small DOM helpers shared by every UI component. Kept deliberately tiny: the UI
// is plain DOM + SVG, and these helpers only remove boilerplate.

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      if (isSvg) el.setAttribute('class', cls); else el.className = cls;
    } else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else for (const [k, v] of Object.entries(value)) {
        if (v == null) continue;
        if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v;
      }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = v;
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (!isSvg && (key === 'value' || key === 'checked' || key === 'disabled' || key === 'tabIndex' || key === 'hidden')) {
      el[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Create an HTML element: h('button', { class: 'btn', onClick }, 'Label'). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  append(el, children);
  return el;
}

/** Create an SVG element with the same calling convention as h(). */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

/** Parse a trusted, static SVG/HTML string (our own icon markup) into a node. */
export function fromHTML(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Write text only when it changed, so per-frame refreshes cost nothing. */
export function setText(el, text) {
  const t = String(text);
  if (el.textContent !== t) el.textContent = t;
}

export function setAttr(el, name, value) {
  const v = value == null ? null : String(value);
  if (el.getAttribute(name) !== v) {
    if (v == null) el.removeAttribute(name); else el.setAttribute(name, v);
  }
}

let uid = 0;
export function uniqueId(prefix = 'og') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Lifecycle scope: collects disposers (store unsubscribes, DOM listeners,
 * timers) so a component can be torn down or rebound without leaks.
 */
export function createScope() {
  const fns = [];
  return {
    add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; },
    on(target, type, fn, opts) {
      if (!target || typeof target.addEventListener !== 'function') return () => {};
      target.addEventListener(type, fn, opts);
      const off = () => target.removeEventListener(type, fn, opts);
      fns.push(off);
      return off;
    },
    dispose() {
      while (fns.length) {
        const fn = fns.pop();
        try { fn(); } catch (err) { console.warn('[ui] dispose failed', err); }
      }
    },
  };
}

/**
 * Subscribe to a module emitter whose `on` may return an unsubscribe function
 * or may expect a matching `off`. Never throws: a missing or broken emitter
 * simply yields a no-op disposer.
 */
export function listen(emitter, event, fn) {
  if (!emitter || typeof emitter.on !== 'function') return () => {};
  let ret;
  try {
    ret = emitter.on(event, fn);
  } catch (err) {
    console.warn(`[ui] could not listen for "${event}"`, err);
    return () => {};
  }
  return () => {
    try {
      if (typeof ret === 'function') ret();
      else if (typeof emitter.off === 'function') emitter.off(event, fn);
    } catch { /* already gone */ }
  };
}

const warned = new Set();
/** Call obj[method](...args) if it exists; log a warning once on failure. */
export function call(obj, method, ...args) {
  if (!obj || typeof obj[method] !== 'function') return undefined;
  try {
    return obj[method](...args);
  } catch (err) {
    if (!warned.has(method)) { warned.add(method); console.warn(`[ui] ${method} failed`, err); }
    return undefined;
  }
}

export function has(obj, method) {
  return !!obj && typeof obj[method] === 'function';
}

/** True when keyboard input should go to a text field rather than shortcuts. */
export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

export function prefersReducedMotion() {
  if (document.documentElement.dataset.motion === 'reduce') return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Download a Blob under a filename without leaving object URLs behind. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Focusable descendants in DOM order (for focus traps and roving focus). */
export function focusables(root) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(sel)].filter(el => !el.closest('[hidden]') && !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Track whether an element is on screen without reading layout every frame
 * (per-frame layout reads after style writes force synchronous reflow).
 * Returns { visible(), dispose() }.
 */
export function watchVisibility(el) {
  let visible = true;
  if (typeof IntersectionObserver === 'undefined') return { visible: () => el.isConnected, dispose() {} };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible = e.isIntersecting;
  });
  io.observe(el);
  return { visible: () => visible && !document.hidden, dispose: () => io.disconnect() };
}

/** Cache an element's size (CSS px), updated by ResizeObserver instead of per-frame reads. */
export function watchSize(el, onChange) {
  const size = { width: el.clientWidth || 0, height: el.clientHeight || 0 };
  if (typeof ResizeObserver === 'undefined') return { size, dispose() {} };
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.contentRect;
      size.width = box.width;
      size.height = box.height;
    }
    if (onChange) onChange(size);
  });
  ro.observe(el);
  return { size, dispose: () => ro.disconnect() };
}
