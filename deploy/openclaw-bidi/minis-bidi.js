// MinisManager patch for the OpenClaw Control UI: each paragraph, list, heading and table cell in a
// chat message gets its own direction — right-to-left when it is mostly Arabic, left-to-right when
// mostly English — so mixed messages read naturally. A line that starts with an English word
// ("SearXNG …") but is Arabic still goes RTL. Code blocks stay LTR. Text boxes use dir="auto".
// Installed by ~/MinisManager/deploy/openclaw-bidi/apply.sh (re-run it after OpenClaw updates).
const BLOCKS = 'p,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,summary';
const SCOPES = '.chat-text,.chat-thinking';
const INPUTS = 'textarea,input[type=text],input[type=search],input:not([type]),[contenteditable=true]';
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR = /[A-Za-zÀ-ɏ]/g;

/** Text of the block without code (commands and paths shouldn't make a line English). */
function prose(el) {
  let s = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1 && !/^(CODE|PRE|KBD|SAMP)$/.test(c.tagName)) walk(c);
    }
  };
  walk(el);
  return s;
}

function decide(el) {
  const t = prose(el);
  const r = (t.match(RTL) || []).length;
  const l = (t.match(LTR) || []).length;
  const dir = r === 0 && l === 0 ? 'auto' : r * 2 >= l ? 'rtl' : 'ltr';
  if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
}

const managed = (el) => el.dataset.minisDir === '1';
function claim(el) {
  if (el.closest('pre,code')) return;
  if (el.hasAttribute('dir') && !managed(el)) return; // OpenClaw set it on purpose
  el.dataset.minisDir = '1';
  decide(el);
}

function scan(root) {
  if (!(root instanceof Element)) return;
  for (const el of root.matches(INPUTS) ? [root] : root.querySelectorAll(INPUTS)) if (!el.hasAttribute('dir')) el.setAttribute('dir', 'auto');
  const scopes = root.closest(SCOPES) ? [root] : root.querySelectorAll(SCOPES);
  for (const s of scopes) {
    if (s.matches(BLOCKS)) claim(s);
    for (const el of s.querySelectorAll(BLOCKS)) claim(el);
  }
}

// Streaming changes text inside existing blocks: re-decide those (batched per frame).
let pending = new Set();
let queued = false;
function touch(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.closest(SCOPES)) return;
  for (let b = el.closest(BLOCKS); b && b.closest(SCOPES); b = b.parentElement?.closest(BLOCKS)) if (managed(b)) pending.add(b);
  if (!queued) {
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const list = pending;
      pending = new Set();
      for (const b of list) if (b.isConnected) decide(b);
    });
  }
}

const start = () => {
  scan(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') touch(m.target);
      else
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) scan(n);
          touch(n.nodeType === 1 ? n : m.target);
        }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
};
if (document.body) start();
else addEventListener('DOMContentLoaded', start, { once: true });
