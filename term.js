/* CTF Practice · terminal widget (keyboard, history, tab completion, paste, nano overlay).
   Gives shell.js an io object: write, readLine, edit, clear, checkInterrupt, afterCommand. */
(function (global) {
  'use strict';
  const { Interrupt } = global.CTFShell;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  class Terminal {
    constructor(container, opts) {
      this.opts = opts || {};
      this.root = el('div', 'term-wrap');
      this.screen = el('div', 'term-screen'); this.screen.setAttribute('role', 'log'); this.screen.setAttribute('aria-live', 'polite');
      this.out = el('div', 'term-out');
      this.lineEl = el('div', 'term-line');
      this.screen.appendChild(this.out); this.screen.appendChild(this.lineEl);
      this.input = el('textarea', 'term-input'); this.input.setAttribute('aria-label', 'terminal input'); this.input.setAttribute('autocapitalize', 'off'); this.input.setAttribute('autocomplete', 'off'); this.input.setAttribute('autocorrect', 'off'); this.input.setAttribute('spellcheck', 'false');
      this.nano = el('div', 'nano'); this.nano.hidden = true;
      this.root.appendChild(this.screen); this.root.appendChild(this.input); this.root.appendChild(this.nano);
      container.appendChild(this.root);
      this.pending = null; // {resolve, reject, opts}
      this.buf = ''; this.cursor = 0; this.histIdx = -1; this.histDraft = '';
      this.queuedLines = []; this.interrupted = false; this.chars = 0; this.flushTimer = null; this.flushBuf = '';
      this.history = [];
      this.screen.addEventListener('mousedown', e => { if (window.getSelection && String(window.getSelection())) return; setTimeout(() => this.focus(), 0); });
      this.screen.addEventListener('click', () => { if (!String(window.getSelection())) this.focus(); });
      this.input.addEventListener('keydown', e => this.onKey(e));
      this.input.addEventListener('paste', e => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text'); this.pasteText(t); });
      this.input.addEventListener('input', e => { // mobile keyboards type here
        const v = this.input.value; if (!v) return; this.input.value = '';
        if (v === '\n') { this.submit(); return; }
        this.insert(v.replace(/\n/g, ''));
      });
      this.input.addEventListener('blur', () => this.root.classList.remove('focused'));
      this.input.addEventListener('focus', () => this.root.classList.add('focused'));
      this.renderLine();
    }
    focus() { this.input.focus({ preventScroll: true }); }

    /* ---- output ---- */
    write(text) {
      if (!text) return;
      this.flushBuf += String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (!this.flushTimer) this.flushTimer = requestAnimationFrame(() => this.flush());
    }
    flush() {
      this.flushTimer = null; if (!this.flushBuf) return;
      const t = this.flushBuf; this.flushBuf = '';
      const last = this.out.lastChild;
      if (last && last.nodeType === 3 && last.data.length < 4000) last.data += t; else this.out.appendChild(document.createTextNode(t));
      this.chars += t.length;
      while (this.chars > 1500000 && this.out.firstChild) { this.chars -= this.out.firstChild.data.length; this.out.removeChild(this.out.firstChild); }
      this.scrollBottom();
    }
    scrollBottom() { this.screen.scrollTop = this.screen.scrollHeight; }
    clear() { this.flush(); this.out.textContent = ''; this.chars = 0; }

    /* ---- input line ---- */
    renderLine() {
      const p = this.pending; const L = this.lineEl; L.textContent = '';
      if (!p) { L.hidden = true; return; }
      L.hidden = false;
      const prompt = p.opts.prompt;
      if (prompt && typeof prompt === 'object') { const s1 = el('span', 'pr-user', prompt.user + '@' + prompt.host); const s2 = el('span', 'pr-sep', ':'); const s3 = el('span', 'pr-cwd', prompt.cwd); const s4 = el('span', 'pr-sep', '$ '); L.append(s1, s2, s3, s4); }
      else if (prompt) L.appendChild(el('span', 'pr-plain', prompt));
      if (p.opts.spin) { L.appendChild(el('span', 'caret', ' ')); return; }
      const shown = p.opts.hidden ? '' : this.buf;
      const before = shown.slice(0, p.opts.hidden ? 0 : this.cursor); const at = p.opts.hidden ? ' ' : (shown[this.cursor] || ' '); const after = p.opts.hidden ? '' : shown.slice(this.cursor + 1);
      L.appendChild(document.createTextNode(before)); L.appendChild(el('span', 'caret', at)); L.appendChild(document.createTextNode(after));
      this.scrollBottom();
    }
    readLine(opts) {
      opts = opts || {};
      return new Promise((resolve, reject) => {
        this.flush();
        if (this.interrupted) { this.interrupted = false; reject(new Interrupt()); return; }
        this.pending = { resolve, reject, opts }; this.buf = ''; this.cursor = 0; this.histIdx = -1;
        if (opts.history) this.history = opts.history;
        if (opts.spin && opts.tick) { this.tickTimer = setInterval(() => { try { opts.tick(); } catch (e) { } }, 350); }
        this.renderLine();
        if (!opts.spin && this.queuedLines.length) { const l = this.queuedLines.shift(); this.buf = l; this.cursor = l.length; this.renderLine(); setTimeout(() => this.submit(), 0); }
        this.focus();
      });
    }
    finish(fn) { const p = this.pending; this.pending = null; if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; } this.renderLine(); fn(p); }
    submit() {
      const p = this.pending; if (!p || p.opts.spin) return;
      const line = this.buf;
      this.write((p.opts.prompt && typeof p.opts.prompt === 'object' ? p.opts.prompt.text : (p.opts.prompt || '')) + (p.opts.hidden ? '' : line) + '\n');
      this.finish(q => q.resolve(line));
    }
    insert(t) { const p = this.pending; if (!p || p.opts.spin) return; this.buf = this.buf.slice(0, this.cursor) + t + this.buf.slice(this.cursor); this.cursor += t.length; this.renderLine(); }
    pasteText(t) {
      if (!t) return; t = t.replace(/\r\n?/g, '\n');
      const lines = t.split('\n');
      const first = lines.shift();
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      this.insert(first);
      if (lines.length || t.endsWith('\n')) { this.queuedLines.push(...lines); this.submit(); }
    }
    checkInterrupt() { if (this.interrupted) { this.interrupted = false; throw new Interrupt(); } }
    onKey(e) {
      const p = this.pending; const k = e.key; const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (k === 'v' || k === 'V')) return; // let the paste event handle it (Ctrl+V and Ctrl+Shift+V both work here)
      if (ctrl && (k === 'c' || k === 'C') && !e.shiftKey) {
        if (String(window.getSelection())) return; // copying a selection
        e.preventDefault();
        if (p) { const q = p; this.write((q.opts.prompt && typeof q.opts.prompt === 'object' ? q.opts.prompt.text : (q.opts.prompt || '')) + (q.opts.hidden || q.opts.spin ? '' : this.buf)); this.queuedLines = []; this.finish(x => x.reject(new Interrupt())); }
        else { this.interrupted = true; this.queuedLines = []; }
        return;
      }
      if (ctrl && (k === 'c' || k === 'C') && e.shiftKey) return; // copy
      if (!p) { if (!ctrl && k.length === 1) e.preventDefault(); return; }
      if (p.opts.spin) { if (k !== 'Shift' && k !== 'Control' && k !== 'Meta' && k !== 'Alt') e.preventDefault(); return; }
      if (k === 'Enter') { e.preventDefault(); this.submit(); return; }
      if (k === 'Backspace') { e.preventDefault(); if (ctrl) { const m = this.buf.slice(0, this.cursor).match(/\S*\s*$/); const n = m ? m[0].length : 0; this.buf = this.buf.slice(0, this.cursor - n) + this.buf.slice(this.cursor); this.cursor -= n; } else if (this.cursor > 0) { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; } this.renderLine(); return; }
      if (k === 'Delete') { e.preventDefault(); this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1); this.renderLine(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); if (ctrl) { const m = this.buf.slice(0, this.cursor).match(/\S*\s*$/); this.cursor -= m ? m[0].length : 0; } else if (this.cursor > 0) this.cursor--; this.renderLine(); return; }
      if (k === 'ArrowRight') { e.preventDefault(); if (ctrl) { const m = this.buf.slice(this.cursor).match(/^\s*\S*/); this.cursor += m ? m[0].length : 0; } else if (this.cursor < this.buf.length) this.cursor++; this.renderLine(); return; }
      if (k === 'Home' || (ctrl && k === 'a')) { e.preventDefault(); this.cursor = 0; this.renderLine(); return; }
      if (k === 'End' || (ctrl && k === 'e')) { e.preventDefault(); this.cursor = this.buf.length; this.renderLine(); return; }
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); if (p.opts.hidden) return; const h = this.history || []; if (!h.length) return; if (this.histIdx === -1) this.histDraft = this.buf; if (k === 'ArrowUp') { if (this.histIdx === -1) this.histIdx = h.length - 1; else if (this.histIdx > 0) this.histIdx--; } else { if (this.histIdx === -1) return; this.histIdx++; if (this.histIdx >= h.length) { this.histIdx = -1; } } this.buf = this.histIdx === -1 ? this.histDraft : h[this.histIdx]; this.cursor = this.buf.length; this.renderLine(); return; }
      if (k === 'Tab') { e.preventDefault(); this.tabComplete(); return; }
      if (ctrl && k === 'l') { e.preventDefault(); this.clear(); return; }
      if (ctrl && k === 'd') { e.preventDefault(); if (!this.buf.length) { this.write((p.opts.prompt && typeof p.opts.prompt === 'object' ? p.opts.prompt.text : (p.opts.prompt || ''))); this.finish(x => x.resolve(null)); } return; }
      if (ctrl && k === 'u') { e.preventDefault(); this.buf = this.buf.slice(this.cursor); this.cursor = 0; this.renderLine(); return; }
      if (ctrl && k === 'k') { e.preventDefault(); this.buf = this.buf.slice(0, this.cursor); this.renderLine(); return; }
      if (ctrl || e.altKey) return;
      if (k.length === 1) { e.preventDefault(); this.insert(k); }
    }
    tabComplete() {
      const p = this.pending; if (!p || !p.opts.complete) return;
      const left = this.buf.slice(0, this.cursor);
      const r = p.opts.complete(left); if (!r || !r.options.length) return;
      if (r.options.length === 1) { const o = r.options[0]; const add = o.slice(r.word.length) + (r.isDir && r.isDir[o] ? '/' : (left.endsWith(' ') ? '' : ' ')); this.insert(add); return; }
      // common prefix
      let pre = r.options[0]; for (const o of r.options) { let i = 0; while (i < pre.length && i < o.length && pre[i] === o[i]) i++; pre = pre.slice(0, i); }
      if (pre.length > r.word.length) { this.insert(pre.slice(r.word.length)); return; }
      const promptText = p.opts.prompt && typeof p.opts.prompt === 'object' ? p.opts.prompt.text : (p.opts.prompt || '');
      this.write(promptText + this.buf + '\n' + r.options.map(o => o.split('/').pop() + (r.isDir && r.isDir[o] ? '/' : '')).join('  ') + '\n');
    }

    /* ---- nano ---- */
    edit(name, text, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        const N = this.nano; N.textContent = ''; N.hidden = false; this.screen.hidden = true;
        const title = el('div', 'nano-title'); const tl = el('span', '', '  GNU nano 7.2'); const tc = el('span', 'nano-file', name); const tm = el('span', 'nano-mod', ''); title.append(tl, tc, tm);
        const ta = el('textarea', 'nano-text'); ta.value = text; ta.setAttribute('spellcheck', 'false'); ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off');
        const status = el('div', 'nano-status', opts.isNew ? '[ New File ]' : `[ Read ${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} lines ]`);
        const promptRow = el('div', 'nano-prompt'); promptRow.hidden = true;
        const help = el('div', 'nano-help');
        const keys = [['^G', 'Help'], ['^O', 'Write Out'], ['^F', 'Where Is'], ['^K', 'Cut'], ['^U', 'Paste'], ['^C', 'Location'], ['^X', 'Exit'], ['^_', 'Go To Line'], ['^A', 'Select All'], ['^Z', 'Undo'], ['^Y', 'Redo'], ['^J', 'Justify']];
        for (const [k, d] of keys) { const s = el('span', 'nano-key'); s.append(el('b', '', k), ' ' + d); help.appendChild(s); }
        N.append(title, ta, status, promptRow, help);
        const original = text; let cut = ''; let modified = false;
        const setStatus = m => { status.textContent = m; };
        const markMod = () => { if (ta.value !== original && !modified) { modified = true; tm.textContent = 'Modified'; } };
        ta.addEventListener('input', markMod);
        const close = (saved, content) => { N.hidden = true; this.screen.hidden = false; N.textContent = ''; this.focus(); resolve({ saved, content }); };
        const ask = (label, onAnswer, kind) => new Promise(done => {
          promptRow.hidden = false; promptRow.textContent = ''; const lab = el('span', 'nano-plabel', label);
          promptRow.appendChild(lab);
          if (kind === 'yn') { const h = el('span', 'nano-yn', '  Y Yes   N No   ^C Cancel'); promptRow.appendChild(h); const handler = ev => { const key = ev.key.toLowerCase(); if (key === 'y' || key === 'n' || (ev.ctrlKey && key === 'c')) { ev.preventDefault(); ev.stopPropagation(); ta.removeEventListener('keydown', handler, true); promptRow.hidden = true; done(key === 'y' ? 'y' : key === 'n' ? 'n' : null); } else { ev.preventDefault(); ev.stopPropagation(); } }; ta.addEventListener('keydown', handler, true); return; }
          const inp = el('input', 'nano-pinput'); inp.value = kind === 'file' ? name : ''; promptRow.appendChild(inp); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
          inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); promptRow.hidden = true; ta.focus(); done(inp.value); } else if (ev.key === 'Escape' || (ev.ctrlKey && ev.key.toLowerCase() === 'c')) { ev.preventDefault(); promptRow.hidden = true; ta.focus(); done(null); } ev.stopPropagation(); });
        });
        const save = async () => { const fn = await ask('File Name to Write: ', null, 'file'); if (fn == null) { setStatus('[ Cancelled ]'); return false; } const lines = ta.value.split('\n').length - (ta.value.endsWith('\n') ? 1 : 0); setStatus(`[ Wrote ${lines} line${lines === 1 ? '' : 's'} ]`); modified = false; tm.textContent = ''; return { name: fn, content: ta.value }; };
        ta.addEventListener('keydown', async ev => {
          const k = ev.key.toLowerCase(); const ctrl = ev.ctrlKey || ev.metaKey;
          if (!ctrl) { if (ev.key === 'Tab') { ev.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); markMod(); } return; }
          if (k === 'v') return; if (k === 'c' && String(window.getSelection())) return;
          if (!['o', 'x', 'k', 'u', 'w', 'f', 'c', 'g', '_', '-', 'j'].includes(k)) return; // Ctrl+End, Ctrl+Z, Ctrl+A etc. keep working
          ev.preventDefault();
          if (k === 'o') { const r = await save(); if (r) this._nanoSaved = r; return; }
          if (k === 'x') { if (modified) { const a = await ask('Save modified buffer? ', null, 'yn'); if (a === null) { setStatus('[ Cancelled ]'); return; } if (a === 'y') { const r = await save(); if (!r) return; close(true, r.content); return; } close(!!this._nanoSaved, this._nanoSaved ? this._nanoSaved.content : original); return; } close(!!this._nanoSaved, this._nanoSaved ? this._nanoSaved.content : original); return; }
          if (k === 'k') { const v = ta.value; const s = ta.selectionStart; const a = v.lastIndexOf('\n', s - 1) + 1; let b = v.indexOf('\n', s); b = b < 0 ? v.length : b + 1; cut = v.slice(a, b); ta.setRangeText('', a, b, 'start'); markMod(); return; }
          if (k === 'u') { if (cut) { ta.setRangeText(cut, ta.selectionStart, ta.selectionEnd, 'end'); markMod(); } return; }
          if (k === 'w' || k === 'f') { const q = await ask('Search: ', null, 'text'); if (!q) return; const from = ta.selectionEnd; let i = ta.value.indexOf(q, from); if (i < 0) i = ta.value.indexOf(q); if (i < 0) { setStatus(`[ "${q}" not found ]`); return; } ta.setSelectionRange(i, i + q.length); ta.focus(); return; }
          if (k === 'c') { const v = ta.value.slice(0, ta.selectionStart); const line = v.split('\n').length; const total = ta.value.split('\n').length; const col = v.length - v.lastIndexOf('\n'); setStatus(`[ line ${line}/${total} (${Math.round(line / total * 100)}%), col ${col}, char ${v.length}/${ta.value.length} ]`); return; }
          if (k === 'g') { setStatus('[ Ctrl+O then Enter saves · Ctrl+X leaves · Ctrl+K cuts a line · Ctrl+U pastes it back · Ctrl+W searches · arrows move ]'); return; }
          if (k === '_' || k === '-') { const n = parseInt(await ask('Enter line number: ', null, 'text'), 10); if (!n) return; const lines = ta.value.split('\n'); let pos = 0; for (let i = 0; i < Math.min(n - 1, lines.length); i++) pos += lines[i].length + 1; ta.setSelectionRange(pos, pos); ta.focus(); return; }
          if (k === 'j') { setStatus('[ Not available on this machine ]'); return; }
        });
        this._nanoSaved = null;
        setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 0);
      });
    }
  }

  global.CTFTerminal = Terminal;
})(window);
