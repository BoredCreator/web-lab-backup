/* CTF Practice · page logic: challenge grid, challenge page, admin page. Static-host friendly. */
(function () {
  'use strict';
  const CFG = window.CTF_CONFIG || {};
  const API = (CFG.API_BASE || '/api/ctf').replace(/\/$/, '');
  const $ = (s, r) => (r || document).querySelector(s);
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const k in attrs || {}) { if (k === 'class') e.className = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); } for (const k of kids) if (k != null) e.append(k); return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }, del(k) { try { localStorage.removeItem(k); } catch (e) { } } };
  let toastTimer; function toast(msg) { let t = $('.toast'); if (!t) { t = h('div', { class: 'toast' }); document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }

  async function loadManifest() { const r = await fetch('challenges.json', { cache: 'no-cache' }); if (!r.ok) throw new Error('challenges.json ' + r.status); return r.json(); }
  async function fetchState() {
    try { const r = await fetch(API + '/state', { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); const j = await r.json(); return { unlocked: j.unlocked || [], all: !!j.all, updatedAt: j.updatedAt, online: true }; }
    catch (e) { return { unlocked: [], all: !!CFG.UNLOCK_ALL_WHEN_OFFLINE, online: false, error: String(e.message || e) }; }
  }
  const isUnlocked = (state, slug) => state.all || state.unlocked.includes(slug);
  const isRevealed = (state, slug) => state.unlocked.includes(slug + '#reveal');

  /* sha256 (for the flag check) with a fallback when crypto.subtle is unavailable (file:// previews) */
  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    if (window.crypto && crypto.subtle && (window.isSecureContext !== false)) { try { const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); } catch (e) { } }
    return sha256js(bytes);
  }
  function sha256js(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length; const withOne = new Uint8Array(((l + 9 + 63) >> 6) << 6); withOne.set(bytes); withOne[l] = 0x80; const dv = new DataView(withOne.buffer); dv.setUint32(withOne.length - 4, l * 8 >>> 0); dv.setUint32(withOne.length - 8, Math.floor(l * 8 / 4294967296));
    const w = new Uint32Array(64); const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < withOne.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3); const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      let [a, b, c, d, e, f, g, hh] = H;
      for (let i = 0; i < 64; i++) { const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25); const ch = (e & f) ^ (~e & g); const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0; const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22); const maj = (a & b) ^ (a & c) ^ (b & c); const t2 = (S0 + maj) >>> 0; hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
      H = H.map((x, i) => (x + [a, b, c, d, e, f, g, hh][i]) >>> 0);
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
  }

  function header(sub) {
    const hd = $('header.top'); if (!hd) return;
    hd.innerHTML = `<a class="brand" href="./">CTF<b>{</b>practice<b>}</b></a><span class="club">${esc(CFG.CLUB_NAME || '')}${sub ? ' · ' + esc(sub) : ''}</span><span class="right"><span class="dot" id="apidot" title="unlock server"></span><span id="apitext">checking</span></span>`;
  }
  function setApiDot(state) { const d = $('#apidot'), t = $('#apitext'); if (!d) return; d.className = 'dot ' + (state.online ? 'on' : 'off'); t.textContent = state.online ? 'live' : (state.all ? 'offline · all open' : 'offline · locks unknown'); }

  /* ---------------- index ---------------- */
  async function pageIndex() {
    header();
    const m = await loadManifest(); const root = $('#grid');
    const solved = new Set(store.get('ctf.solved', []));
    let state = await fetchState(); setApiDot(state);
    function render() {
      root.textContent = '';
      for (const g of m.groups) {
        const list = m.challenges.filter(c => c.group === g.id); if (!list.length) continue;
        root.appendChild(h('h2', {}, g.title));
        const grid = h('div', { class: 'grid' });
        for (const c of list) {
          const un = isUnlocked(state, c.slug); const sv = solved.has(c.slug);
          const card = h('a', { class: 'card' + (un ? '' : ' locked') + (sv ? ' solved' : ''), href: un ? 'challenge.html?c=' + encodeURIComponent(c.slug) : '#', 'aria-disabled': un ? 'false' : 'true' },
            h('div', { class: 'nm' }, c.name, h('span', { class: 'diff ' + (c.difficulty || 'easy') }, c.difficulty || 'easy')),
            h('div', { class: 'cat' }, c.category + (c.web ? ' · browser' : '')),
            c.proxy ? null : h('div', { class: 'idea' }, c.idea || ''),
            h('div', { class: 'badge' }, sv ? '✓ solved' : (un ? 'open' : 'locked')));
          grid.appendChild(card);
        }
        root.appendChild(grid);
      }
      const n = m.challenges.filter(c => isUnlocked(state, c.slug)).length;
      $('#count').textContent = `${n} of ${m.challenges.length} open`;
    }
    render();
    setInterval(async () => { const s = await fetchState(); const changed = JSON.stringify([s.all, s.unlocked]) !== JSON.stringify([state.all, state.unlocked]); state = s; setApiDot(state); if (changed) render(); }, CFG.POLL_MS || 8000);
  }

  /* ---------------- challenge page ---------------- */
  function renderCommand(cmd) {
    // green command words, amber [placeholders], blue key combos / browser steps
    const html = esc(cmd).replace(/\[[^\]]+\]/g, m => `<span class="arg">${m}</span>`).replace(/(Ctrl\+[A-Za-z+]+|F12|Enter|Tab|up arrow|view-source:|DevTools|Application|Network|Sources|Elements|Console|reload|right-click|address bar)/g, m => `<span class="key">${m}</span>`);
    return html;
  }
  function descHtml(c) {
    let d = c.description || '';
    d = d.replace(/\{dl:([^}]+)\}/g, (m, name) => { const dl = (c.downloads || {})[name]; const url = dl ? dl.url : name; return `<a class="dl" href="${esc(url)}" data-url="${esc(url)}" title="click to copy the link">${esc(dl && dl.label || name)}</a>`; });
    d = d.replace(/\{conn:([^}]+)\}/g, (m, t) => `<span class="conn">${esc(t)}</span>`);
    d = d.replace(/\{weburl\}/g, () => c.web ? `<a href="${esc(c.web.url)}" target="_blank" rel="noopener">${esc(c.web.label || 'the website')}</a>` : '');
    return d.split(/\n\n+/).map(p => `<p>${p}</p>`).join('');
  }
  async function pageChallenge() {
    const slug = new URLSearchParams(location.search).get('c');
    const m = await loadManifest(); const c = m.challenges.find(x => x.slug === slug);
    header(c ? c.name : 'challenge');
    const main = $('#main');
    if (!c) { main.innerHTML = '<div class="lockmsg"><div class="big">404</div>No such challenge. <a href="./">Back to the list</a></div>'; return; }
    document.title = c.name + ' · CTF Practice';
    let state = await fetchState(); setApiDot(state);
    const key = new URLSearchParams(location.search).get('preview') === '1';
    if (!isUnlocked(state, slug) && !key) {
      main.innerHTML = `<div class="lockmsg"><div class="big">locked</div><p>${esc(c.name)} is not open yet. Neel unlocks it from the front of the room.<br>This page checks again every few seconds.</p><p><a href="./">Back to the list</a></p></div>`;
      const t = setInterval(async () => { state = await fetchState(); setApiDot(state); if (isUnlocked(state, slug)) { clearInterval(t); location.reload(); } }, CFG.POLL_MS || 8000);
      return;
    }
    // layout
    const group = m.groups.find(g => g.id === c.group);
    main.innerHTML = '';
    main.append(...[
      h('div', { class: 'chal-head' }, h('h1', {}, c.name), h('span', { class: 'cat' }, `${c.category} · ${c.difficulty || 'easy'}${group ? ' · ' + group.title : ''}`)),
      c.proxy ? null : h('p', { class: 'lead' }, c.idea ? 'New idea: ' + c.idea : ''),
      c.proxy ? null : h('div', { class: 'desc', html: descHtml(c) })].filter(Boolean));
    if (c.web) main.append(h('div', { class: 'webbtn' }, h('a', { class: 'btn primary', href: c.web.url, target: '_blank', rel: 'noopener' }, 'Open the website ↗'), ' ', h('span', { class: 'muted' }, ' opens in a new tab · the terminal below is only a backup')));
    if (c.proxy) { renderProxyChallenge(main, c, slug); setInterval(async () => { const s = await fetchState(); setApiDot(s); }, (CFG.POLL_MS || 8000) * 2); return; }
    const two = h('div', { class: 'two' }); main.append(two);
    const left = h('div', {}); const right = h('div', {}); two.append(left, right);
    // commands panel
    const revealed = isRevealed(state, slug) || key;
    const tbl = h('table', {});
    for (const row of c.commands || []) {
      const hidden = row.secret && !revealed;
      tbl.appendChild(h('tr', { class: hidden ? 'secret' : '' }, h('td', { class: 'c', html: hidden ? '<span class="mask">' + '█'.repeat(Math.max(6, Math.min(14, row.cmd.length))) + '</span>' : renderCommand(row.cmd) }), h('td', { class: 'e' }, row.expl || '')));
    }
    const anySecret = (c.commands || []).some(r => r.secret) || (c.hints || []).some(t => t && t.secret);
    left.append(h('div', { class: 'cmds' }, h('div', { class: 'bar' }, 'commands you need · [brackets] are yours to fill in' + (anySecret && !revealed ? ' · blacked-out lines unlock next week' : '')), tbl));
    if (c.hints && c.hints.length) { const hs = h('div', { class: 'hints' }); c.hints.forEach((t, i) => { const text = typeof t === 'string' ? t : t.text; const hidden = t && t.secret && !revealed; hs.appendChild(h('details', { class: hidden ? 'secret' : '' }, h('summary', {}, `hint ${i + 1}` + (hidden ? ' · locked until next week' : '')), h('p', {}, hidden ? 'Neel unlocks this hint from the front of the room.' : text))); }); left.append(hs); }
    // flag box
    const fin = h('input', { type: 'text', placeholder: (c.flagFormat || 'flipped{...}'), autocomplete: 'off', spellcheck: 'false' });
    const fmsg = h('div', { class: 'flag-msg' });
    const check = async () => { const v = fin.value.trim(); if (!v) return; const hsh = await sha256(v); if (hsh === c.flagHash) { fmsg.className = 'flag-msg ok'; fmsg.textContent = (c.points === 2 ? 'Correct! Show Neel the screen for 2 points.' : 'Correct! Show Neel the screen for the point.'); const s = new Set(store.get('ctf.solved', [])); s.add(slug); store.set('ctf.solved', [...s]); } else { fmsg.className = 'flag-msg bad'; fmsg.textContent = /^(pico|academy)/i.test(v) ? 'Close: this site uses flipped{...} as the wrapper. Keep the inside, swap the front word.' : (!/\{.*\}/.test(v) ? 'A flag looks like flipped{...}: the wrapper is part of it.' : 'Not it. Check for typos, it must match exactly.'); } };
    fin.addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
    left.append(h('div', { class: 'flagbox' }, fin, h('button', { class: 'primary', onclick: check }, 'check flag')), fmsg);
    // terminal
    const tb = h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, 'your own Linux machine for this challenge · paste with ', h('kbd', {}, 'Ctrl+V'), ' or ', h('kbd', {}, 'Ctrl+Shift+V')), h('span', { class: 'sp' }), h('button', { class: 'danger', onclick: () => { if (confirm('Reset this machine? Your files and edits for this challenge are wiped and it starts fresh.')) { store.del('ctf.fs.' + slug); location.reload(); } } }, 'reset machine'));
    const tbox = h('div', {}); right.append(tb, tbox);
    main.append(h('footer', {}, h('a', { href: './' }, '← all challenges'), h('span', {}, 'Stuck? ', h('code', {}, 'help'), ' lists the commands, ', h('code', {}, 'man grep'), ' explains one.')));
    bootTerminal(tbox, c, slug);
    // copy-link behaviour for downloads
    main.addEventListener('click', e => { const a = e.target.closest('a.dl'); if (!a) return; e.preventDefault(); const url = a.dataset.url; (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('link copied · paste it after wget'), () => { prompt('Copy this link:', url); }); });
    setInterval(async () => { const s = await fetchState(); setApiDot(s); }, (CFG.POLL_MS || 8000) * 2);
  }
  function makeFlagBox(c, slug) {
    const fin = h('input', { type: 'text', placeholder: (c.flagFormat || 'flipped{...}'), autocomplete: 'off', spellcheck: 'false' });
    const fmsg = h('div', { class: 'flag-msg' });
    const check = async () => { const v = fin.value.trim(); if (!v) return; const hsh = await sha256(v); if (hsh === c.flagHash) { fmsg.className = 'flag-msg ok'; fmsg.textContent = (c.points === 2 ? 'Correct! Show Neel the screen for 2 points.' : 'Correct! Show Neel the screen for the point.'); const s = new Set(store.get('ctf.solved', [])); s.add(slug); store.set('ctf.solved', [...s]); } else { fmsg.className = 'flag-msg bad'; fmsg.textContent = /^(pico|academy)/i.test(v) ? 'Close: this site uses flipped{...} as the wrapper. Keep the inside, swap the front word.' : (!/\{.*\}/.test(v) ? 'A flag looks like flipped{...}: the wrapper is part of it.' : 'Not it. Check for typos, it must match exactly.'); } };
    fin.addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
    return h('div', {}, h('div', { class: 'flagbox' }, fin, h('button', { class: 'primary', onclick: check }, 'check flag')), fmsg);
  }
  function renderProxyChallenge(main, c, slug) {
    const wr = document.querySelector('.wrap'); if (wr) wr.classList.add('wide');
    const box = h('div', {}); main.append(box);
    if (c.hints && c.hints.length) { const hs = h('div', { class: 'hints' }); c.hints.forEach((t, i) => { const text = typeof t === 'string' ? t : t.text; hs.appendChild(h('details', {}, h('summary', {}, `hint ${i + 1}`), h('p', {}, text))); }); main.append(hs); }
    const fb = makeFlagBox(c, slug); fb.classList.add('px-flag'); main.append(fb);
    main.append(h('footer', {}, h('a', { href: './' }, '← all challenges'), h('span', {}, 'The flag shows up on a page or in a response. Read it, then paste it above.')));
    try { new window.CTFProxy.Proxy(box, c.proxy, { toast }); } catch (e) { console.error(e); box.append(h('div', { class: 'note err' }, 'Could not start the browser: ' + e.message)); }
  }
  function bootTerminal(container, c, slug) {
    const { Shell, Session, FS, materialize, ExitShell } = window.CTFShell;
    const term = new window.CTFTerminal(container);
    const fs = new FS(materialize(c.files || {}, slug, '/home/ctf'));
    const saved = store.get('ctf.fs.' + slug, null);
    if (saved && saved.dirty) { try { fs.applyDirty(saved.dirty); } catch (e) { } }
    const session = new Session({ fs, user: 'ctf', host: 'practice', challenge: c, cwd: saved && saved.cwd ? saved.cwd : undefined });
    if (saved && saved.history) session.history = saved.history.slice(-200);
    const io = { write: t => term.write(t), readLine: o => term.readLine(o), edit: (n, t, o) => term.edit(n, t, o), clear: () => term.clear(), checkInterrupt: () => term.checkInterrupt(),
      afterCommand: s => { if (s !== session) return; try { const dirty = fs.dirtyFiles(); const payload = { dirty, cwd: session.cwd, history: session.history.slice(-200) }; if (JSON.stringify(payload).length < 1500000) store.set('ctf.fs.' + slug, payload); } catch (e) { } } };
    const shell = new Shell(io);
    term.write(`Welcome to your practice machine for "${c.name}".\nFiles for this challenge are in this folder. Type help for the command list, man COMMAND for one command.\n\n`);
    (async () => { for (;;) { try { await shell.repl(session); } catch (e) { if (e instanceof ExitShell) { term.write('\nThis is your own machine, there is nowhere to log out to. Reload the page for a fresh one.\n\n'); continue; } console.error(e); term.write('\n[internal error: ' + (e && e.message) + ']\n'); } } })();
    window.__ctf = { term, shell, session, fs };
  }

  /* ---------------- admin ---------------- */
  async function pageAdmin() {
    header('admin');
    const m = await loadManifest(); const root = $('#adm'); const msg = $('#msg');
    let keyVal = sessionStorage.getItem('ctf.adminkey') || '';
    const keyIn = $('#key'); keyIn.value = keyVal;
    let state = await fetchState(); setApiDot(state);
    const boxes = new Map();
    function render() {
      root.textContent = '';
      const t = h('table', {}, h('tr', {}, h('th', {}, 'open'), h('th', {}, 'challenge'), h('th', {}, 'category'), h('th', {}, 'new idea')));
      for (const g of m.groups) {
        t.appendChild(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, g.title)));
        for (const c of m.challenges.filter(x => x.group === g.id)) {
          const cb = h('input', { type: 'checkbox' }); cb.checked = isUnlocked(state, c.slug); boxes.set(c.slug, cb);
          const anySecret = (c.commands || []).some(r => r.secret) || (c.hints || []).some(x => x && x.secret);
          let rv = null; if (anySecret) { rv = h('input', { type: 'checkbox', title: 'reveal the blacked-out commands and locked hints' }); rv.checked = isRevealed(state, c.slug); boxes.set(c.slug + '#reveal', rv); }
          t.appendChild(h('tr', {}, h('td', {}, cb), h('td', {}, h('a', { href: 'challenge.html?c=' + encodeURIComponent(c.slug) + '&preview=1', target: '_blank' }, c.name), rv ? h('label', { class: 'rv' }, rv, ' reveal solution lines') : null), h('td', { class: 'muted' }, c.category), h('td', { class: 'muted' }, c.idea || '')));
        }
      }
      root.appendChild(t);
      $('#allbox').checked = state.all;
      $('#stamp').textContent = state.online ? ('server state' + (state.updatedAt ? ' · updated ' + new Date(state.updatedAt).toLocaleTimeString() : '')) : ('server unreachable: ' + (state.error || ''));
    }
    render();
    async function save() {
      keyVal = keyIn.value.trim(); sessionStorage.setItem('ctf.adminkey', keyVal);
      const unlocked = [...boxes.entries()].filter(([, cb]) => cb.checked).map(([s]) => s);
      const body = { unlocked, all: $('#allbox').checked };
      msg.className = 'note'; msg.textContent = 'saving...';
      try {
        const r = await fetch(API + '/state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keyVal }, body: JSON.stringify(body) });
        if (r.status === 401 || r.status === 403) { msg.className = 'note err'; msg.textContent = 'Wrong admin key.'; return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json(); state = { unlocked: j.unlocked || [], all: !!j.all, updatedAt: j.updatedAt, online: true }; setApiDot(state); render();
        msg.className = 'note ok'; msg.textContent = `Saved. ${unlocked.length} open${body.all ? ' (plus "open everything")' : ''}. Kids' pages pick it up within ${(CFG.POLL_MS || 8000) / 1000}s.`;
      } catch (e) { msg.className = 'note err'; msg.textContent = 'Could not save: ' + e.message; }
    }
    $('#save').addEventListener('click', save);
    $('#openall').addEventListener('click', () => { for (const [k, cb] of boxes) if (!k.includes('#')) cb.checked = true; save(); });
    $('#closeall').addEventListener('click', () => { for (const cb of boxes.values()) cb.checked = false; $('#allbox').checked = false; save(); });
    $('#refresh').addEventListener('click', async () => { state = await fetchState(); setApiDot(state); render(); });
  }

  window.CTFApp = { pageIndex, pageChallenge, pageAdmin, sha256 };
})();
