// Widget sandbox theme stylesheet and postMessage bridge.
// Injected into every widget iframe via srcdoc.

import { PAGE_AGENT_SCRIPT } from "./page-agent-bundle";

export const WIDGET_BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-family: 'Geist Mono', 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.5; color: var(--sig-text); background: var(--sig-bg); -webkit-font-smoothing: antialiased; }
body { margin: 0; padding: 8px; min-height: 100%; }

/* Form elements */
input[type="text"], input[type="number"], input[type="email"], input[type="search"], textarea, select {
  background: var(--sig-surface-raised);
  border: 1px solid var(--sig-border);
  border-radius: 4px;
  color: var(--sig-text);
  font-family: inherit;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  transition: border-color 0.2s;
}
input[type="text"], input[type="number"], input[type="email"], input[type="search"], select {
  height: 32px;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--sig-accent);
}

button {
  background: var(--sig-surface-raised);
  border: 1px solid var(--sig-border);
  border-radius: 3px;
  color: var(--sig-text);
  font-family: inherit;
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.2s;
}
button:hover {
  background: var(--sig-surface);
  border-color: var(--sig-border-strong);
}
button:active {
  transform: translateY(0.5px);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: var(--sig-surface-raised);
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--sig-accent);
  cursor: pointer;
}
input[type="range"]::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: var(--sig-accent);
  cursor: pointer;
}

/* Utility classes */
.sig-panel { background: var(--sig-surface); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
.sig-panel-header { border-bottom: 1px solid rgba(0,0,0,0.4); padding: 6px 10px; }
.sig-switch { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; color: var(--sig-text); font-family: var(--font-mono); font-size: 10px; cursor: pointer; transition: all 0.2s; }
.sig-switch:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.15); }
.sig-switch:active { transform: translateY(0.5px); }
.sig-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em; background: var(--sig-surface-raised); border: 1px solid var(--sig-border); color: var(--sig-text-muted); }
.sig-label { font-size: 11px; color: var(--sig-text-muted); font-family: var(--font-mono); }
.sig-eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sig-text-muted); font-family: var(--font-mono); }
.sig-heading { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sig-text-bright); font-family: var(--font-mono); }
.sig-readout { font-size: 28px; font-weight: 700; font-family: var(--font-mono); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--sig-text-bright); }
.sig-data { font-size: 10px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--sig-text); }
.sig-groove { height: 2px; background: linear-gradient(to bottom, rgba(0,0,0,0.4), rgba(255,255,255,0.05)); }
.sig-divider { height: 1px; background: linear-gradient(to right, transparent, var(--sig-border-strong), transparent); margin: 8px 0; }
.sig-glow { box-shadow: 0 0 20px rgba(200,255,0,0.15); }
.sig-highlight-text { color: var(--sig-highlight-text); }
.sig-highlight-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 9px; background: var(--sig-highlight-dim); border: 1px solid var(--sig-highlight-muted); color: var(--sig-highlight-text); }

/* Animations */
@keyframes sig-flicker { 0%,97%{opacity:1} 98%{opacity:0.85} 99%{opacity:0.95} 100%{opacity:1} }
@keyframes sig-glow-pulse { 0%,100%{box-shadow:0 0 4px var(--sig-highlight)} 50%{box-shadow:0 0 12px var(--sig-highlight),0 0 24px var(--sig-highlight-dim)} }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* Scrollbar */
::-webkit-scrollbar { width: 3px; height: 3px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--sig-border-strong); border-radius: 2px; }
`;

const THEME_VARS = [
	"--sig-bg",
	"--sig-surface",
	"--sig-surface-raised",
	"--sig-border",
	"--sig-border-strong",
	"--sig-text",
	"--sig-text-bright",
	"--sig-text-muted",
	"--sig-accent",
	"--sig-accent-hover",
	"--sig-danger",
	"--sig-warning",
	"--sig-success",
	"--sig-highlight",
	"--sig-highlight-muted",
	"--sig-highlight-dim",
	"--sig-highlight-text",
	"--sig-electric",
	"--sig-electric-muted",
	"--sig-electric-dim",
	"--sig-glow-highlight",
	"--sig-glow-electric",
	"--sig-grid-line",
	"--font-display",
	"--font-mono",
	"--space-xs",
	"--space-sm",
	"--space-md",
	"--space-lg",
	"--ease",
	"--dur",
] as const;

export function buildThemeVars(): string {
	const style = getComputedStyle(document.documentElement);
	const declarations = THEME_VARS.map((v) => `${v}: ${style.getPropertyValue(v).trim()};`)
		.filter((d) => !d.endsWith(": ;"))
		.join("\n  ");
	return `:root {\n  ${declarations}\n}`;
}

export const WIDGET_BRIDGE_SCRIPT = `(function() {
  var rid = 0;
  var pending = new Map();
  var eventListeners = new Map();

  window.signet = {
    callTool: function(name, args) {
      return new Promise(function(resolve, reject) {
        var id = String(++rid);
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ type: 'signet:callTool', id: id, tool: name, args: args || {} }, '*');
      });
    },
    readResource: function(uri) {
      return new Promise(function(resolve, reject) {
        var id = String(++rid);
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ type: 'signet:readResource', id: id, uri: uri }, '*');
      });
    },
    emit: function(eventType, data) {
      parent.postMessage({ type: 'signet:emit', eventType: eventType, data: data }, '*');
    },
    on: function(eventType, callback) {
      if (!eventListeners.has(eventType)) eventListeners.set(eventType, []);
      eventListeners.get(eventType).push(callback);
      return function unsubscribe() {
        var list = eventListeners.get(eventType);
        if (list) {
          var idx = list.indexOf(callback);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    }
  };

  var expectedOrigin = (document.location.ancestorOrigins && document.location.ancestorOrigins.length > 0)
    ? document.location.ancestorOrigins[0]
    : null;

  window.addEventListener('message', function(e) {
    if (expectedOrigin && e.origin !== expectedOrigin) return;
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'signet:result' && pending.has(d.id)) {
      pending.get(d.id).resolve(d.result);
      pending.delete(d.id);
    }
    if (d.type === 'signet:error' && pending.has(d.id)) {
      pending.get(d.id).reject(new Error(d.error));
      pending.delete(d.id);
    }
    if (d.type === 'signet:theme') {
      var root = document.documentElement;
      for (var k in d.vars) {
        if (Object.prototype.hasOwnProperty.call(d.vars, k)) {
          root.style.setProperty(k, d.vars[k]);
        }
      }
    }
    if (d.type === 'signet:event' && d.eventType) {
      var listeners = eventListeners.get(d.eventType) || [];
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](d.data); } catch(e) { console.error('signet event handler error:', e); }
      }
    }
    if (d.type === 'signet:action') {
      if (d.action === 'refresh') {
        // Dispatch DOM event for any listener, then trigger full re-fetch
        window.dispatchEvent(new CustomEvent('signet:refresh', { detail: d.data }));
        // Re-run all useEffect cleanups + mounts by forcing React reconciliation
        // Simplest: dispatch event that our React apps can hook into
        var refreshEvent = new Event('signet-data-refresh');
        window.dispatchEvent(refreshEvent);
      }
      if (d.action === 'navigate') {
        // Dispatch navigate event with target info (e.g., {view: "contact", id: "xxx"})
        window.dispatchEvent(new CustomEvent('signet:navigate', { detail: d.data }));
      }
      if (d.action === 'cursor') {
        var cursorData = d.data || {};
        runCursorSequence(cursorData.steps || d.steps || []);
      }
      if (d.action === 'highlight') {
        // Highlight a specific element by text content match
        var target = d.data && d.data.text;
        if (target) {
          var allCells = document.querySelectorAll('td, .contact-name, .deal-name, [data-id]');
          for (var j = 0; j < allCells.length; j++) {
            if (allCells[j].textContent && allCells[j].textContent.toLowerCase().includes(target.toLowerCase())) {
              allCells[j].scrollIntoView({ behavior: 'smooth', block: 'center' });
              allCells[j].style.outline = '2px solid var(--sig-accent, #c8ff00)';
              allCells[j].style.outlineOffset = '2px';
              allCells[j].style.transition = 'outline 0.3s ease';
              var cell = allCells[j];
              // Find the parent row and click it
              var row = cell.closest('tr') || cell.closest('[data-id]') || cell;
              if (row && row.click) row.click();
              setTimeout(function() { cell.style.outline = 'none'; }, 3000);
              break;
            }
          }
        }
      }
    }
    // --- Page Agent bridge handlers ---
    if (d.type === 'signet:getDomState') {
      (async function() {
        try {
          if (window.signet && window.signet.getDomState) {
            var result = await window.signet.getDomState();
            parent.postMessage({ type: 'signet:domState', id: d.id, result: result }, '*');
          } else {
            parent.postMessage({ type: 'signet:domState', id: d.id, result: { success: false, error: 'PageController not ready' } }, '*');
          }
        } catch(err) {
          parent.postMessage({ type: 'signet:domState', id: d.id, result: { success: false, error: err.message || String(err) } }, '*');
        }
      })();
    }
    if (d.type === 'signet:executeAction') {
      (async function() {
        try {
          if (window.signet && window.signet.executeAction) {
            var result = await window.signet.executeAction(d.action);
            parent.postMessage({ type: 'signet:actionResult', id: d.id, result: result }, '*');
          } else {
            parent.postMessage({ type: 'signet:actionResult', id: d.id, result: { success: false, message: 'PageController not ready' } }, '*');
          }
        } catch(err) {
          parent.postMessage({ type: 'signet:actionResult', id: d.id, result: { success: false, message: err.message || String(err) } }, '*');
        }
      })();
    }
    if (d.type === 'signet:agentStart') {
      if (window.signet && window.signet.agentStart) {
        window.signet.agentStart().catch(function(e) { console.warn('agentStart error:', e); });
      }
    }
    if (d.type === 'signet:agentStop') {
      if (window.signet && window.signet.agentStop) {
        window.signet.agentStop().catch(function(e) { console.warn('agentStop error:', e); });
      }
    }
  });

  // ── Visual cursor for agent automation ──────────────────────────────
  var cursor = document.createElement('div');
  cursor.id = 'signet-cursor';
  cursor.style.cssText = 'position:fixed;width:20px;height:20px;pointer-events:none;z-index:99999;opacity:0;transition:left 0.15s cubic-bezier(0.23,1,0.32,1),top 0.15s cubic-bezier(0.23,1,0.32,1),opacity 0.1s;';
  cursor.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5.65 2.3l12.6 10.1-5.9 1.3-3.4 5.4L5.65 2.3z" fill="rgba(0,188,212,0.9)" stroke="rgba(255,255,255,0.8)" stroke-width="1.5"/></svg>';
  function appendCursorElements() {
    if (document.body) {
      document.body.appendChild(cursor);
      document.body.appendChild(ripple);
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        document.body.appendChild(cursor);
        document.body.appendChild(ripple);
      });
    }
  }

  var ripple = document.createElement('div');
  ripple.style.cssText = 'position:fixed;pointer-events:none;z-index:99998;width:30px;height:30px;border-radius:50%;border:2px solid rgba(0,188,212,0.8);opacity:0;transform:scale(0);';
  appendCursorElements();

  function showCursor() { cursor.style.opacity = '1'; }
  function hideCursor() { cursor.style.opacity = '0'; }

  function moveCursorTo(x, y) {
    return new Promise(function(resolve) {
      showCursor();
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
      setTimeout(resolve, 200);
    });
  }

  function clickAt(x, y) {
    ripple.style.left = (x - 15) + 'px';
    ripple.style.top = (y - 15) + 'px';
    ripple.style.opacity = '1';
    ripple.style.transform = 'scale(0)';
    ripple.offsetHeight;
    ripple.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
    ripple.style.transform = 'scale(2)';
    ripple.style.opacity = '0';

    var el = document.elementFromPoint(x, y);
    if (el) {
      el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y}));
      el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y}));
      el.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:x, clientY:y}));
      if (el.focus) el.focus();
    }
  }

  function typeText(text) {
    return new Promise(function(resolve) {
      var active = document.activeElement;
      if (!active || (!active.tagName.match(/INPUT|TEXTAREA/) && !active.isContentEditable)) {
        resolve();
        return;
      }
      var i = 0;
      function next() {
        if (i >= text.length) { resolve(); return; }
        var ch = text[i++];
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(active, (active.value || '') + ch);
        } else {
          active.value = (active.value || '') + ch;
        }
        active.dispatchEvent(new Event('input', {bubbles:true}));
        active.dispatchEvent(new Event('change', {bubbles:true}));
        setTimeout(next, 15 + Math.random() * 10);
      }
      next();
    });
  }

  function findByText(text) {
    var lower = text.toLowerCase();
    // Check inputs by placeholder first
    var inputs = document.querySelectorAll('input, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].placeholder || inputs[i].name || inputs[i].getAttribute('aria-label') || '').toLowerCase();
      if (ph.includes(lower)) {
        var r = inputs[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2, el: inputs[i] };
      }
    }
    // Check buttons and other interactive elements by text content
    var all = document.querySelectorAll('button, a, td, th, span, label, div, [role="button"]');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var t = (el.textContent || '').trim().toLowerCase();
      if (t.includes(lower) && t.length < 100) {
        var r2 = el.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, el: el };
      }
    }
    return null;
  }

  // Wait for an element to appear in the DOM (retries for up to timeoutMs)
  function waitForElement(text, timeoutMs) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      var interval = 200;
      function check() {
        var found = findByText(text);
        if (found) { resolve(found); return; }
        elapsed += interval;
        if (elapsed >= timeoutMs) { resolve(null); return; }
        setTimeout(check, interval);
      }
      check();
    });
  }

  async function runCursorSequence(steps) {
    // Wait for the widget DOM to be ready before starting
    await new Promise(function(r) { setTimeout(r, 500); });
    showCursor();
    for (var s = 0; s < steps.length; s++) {
      var step = steps[s];
      if (step.action === 'move' && step.target) {
        // Wait up to 3 seconds for the element to appear
        var found = await waitForElement(step.target, 3000);
        if (found) {
          await moveCursorTo(found.x, found.y);
          if (step.click) {
            clickAt(found.x, found.y);
            await new Promise(function(r){setTimeout(r, 200)});
          }
        }
      }
      if (step.action === 'type' && step.text) {
        await typeText(step.text);
        await new Promise(function(r){setTimeout(r, 50)});
      }
      if (step.action === 'wait') {
        await new Promise(function(r){setTimeout(r, step.ms || 150)});
      }
    }
    setTimeout(hideCursor, 2000);
  }

  parent.postMessage({ type: 'signet:ready' }, '*');
})();`;

export function buildSrcdoc(html: string, serverId: string): string {
	const theme = buildThemeVars();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${theme}\n${WIDGET_BASE_CSS}</style>
<script>${WIDGET_BRIDGE_SCRIPT}<\/script>
<script>${PAGE_AGENT_SCRIPT}<\/script>
</head>
<body data-server-id="${serverId.replace(/"/g, '&quot;')}">
${html}
</body>
</html>`;
}
