// Just enough DOM for the Settings panes built with src/ui/dom.js and
// src/ui/controls.js to render and take clicks in Node: elements, attributes,
// classList, dataset, events, text, <select> values and a few selectors, plus
// a manual requestAnimationFrame (flush() runs the queued frames).

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(t) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (t !== '' && t != null) this.appendChild(new FakeText(String(t)));
  }
}

class FakeText extends FakeNode {
  constructor(t) { super(); this.data = t; }
  get textContent() { return this.data; }
  set textContent(t) { this.data = String(t); }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: '', setProperty(k, v) { this[k] = v; } };
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.offsetWidth = 0;
    this.offsetLeft = 0;
    this._html = '';
    this._value = '';
    const cls = new Set();
    this.classList = {
      add: (...n) => n.forEach(x => cls.add(x)),
      remove: (...n) => n.forEach(x => cls.delete(x)),
      contains: (n) => cls.has(n),
      toggle: (n, on) => { const v = on === undefined ? !cls.has(n) : !!on; if (v) cls.add(n); else cls.delete(n); return v; },
    };
    this._cls = cls;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => this._cls.add(c)); }
  set innerHTML(v) { this._html = String(v); this.textContent = ''; }
  get innerHTML() { return this._html; }
  get children() { return this.childNodes.filter(c => c instanceof FakeElement); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { const s = this.listeners.get(t); if (s) s.delete(fn); }
  dispatchEvent(e) {
    e.target = e.target || this;
    for (const fn of [...(this.listeners.get(e.type) || [])]) fn(e);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); }
  focus() { globalThis.document.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 10, width: 100, height: 10 }; }
  setPointerCapture() {}
  /** Descendant elements, depth first. */
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some((s) => {
      const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:=["']?([^"'\]]+)["']?)?\])?(?:\.([\w-]+))?$/i.exec(s);
      if (!m) return false;
      const [, tag, attr, val, cls] = m;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (attr && (val == null ? !this.hasAttribute(attr) : this.getAttribute(attr) !== val)) return false;
      if (cls && !this._cls.has(cls)) return false;
      return true;
    });
  }
  querySelectorAll(sel) { return [...this.walk()].filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // <select> / <option> / <input>
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.tagName === 'SELECT') return this._value !== '' || !this.options.length ? this._value : this.options[0].value;
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
    return this._value;
  }
  set value(v) { this._value = String(v); }
}

/** Install the fake document and frame loop on globalThis; returns {flush, restore}. */
export function installFakeDom() {
  const saved = { document: globalThis.document, Node: globalThis.Node, raf: globalThis.requestAnimationFrame };
  const frames = [];
  globalThis.Node = FakeNode;
  globalThis.document = {
    activeElement: null,
    createElement: (t) => new FakeElement(t),
    createElementNS: (ns, t) => new FakeElement(t),
    createTextNode: (t) => new FakeText(t),
  };
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  return {
    /** Run queued animation frames (and any they queue) until none are left. */
    flush() {
      for (let guard = 0; guard < 50 && frames.length; guard++) {
        const run = frames.splice(0);
        for (const fn of run) fn(0);
      }
    },
    restore() {
      globalThis.document = saved.document;
      globalThis.Node = saved.Node;
      globalThis.requestAnimationFrame = saved.raf;
    },
  };
}

/** Elements whose own text (or aria-label) matches. */
export function findByText(root, re) {
  return [...root.walk()].filter(e => re.test(e.textContent) || re.test(e.getAttribute('aria-label') || ''));
}
