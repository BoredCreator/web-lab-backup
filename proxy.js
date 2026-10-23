/* CTF Practice · a simulated web + HTTP inspector ("the proxy").
   A tiny declarative web server that runs in the browser, a mini-browser that renders its
   pages, and an inspector that logs every request/response and lets you edit one and resend it.
   No DOM assumptions beyond a container element; the challenge's site is data (c.proxy). */
(function (global) {
  'use strict';

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lc(o) { const r = {}; for (const k in o || {}) r[k.toLowerCase()] = o[k]; return r; }
  function parseQuery(path) { const i = path.indexOf('?'); const q = {}; if (i < 0) return { path, q }; const base = path.slice(0, i); for (const pair of path.slice(i + 1).split('&')) { if (!pair) continue; const j = pair.indexOf('='); const k = decodeURIComponent(j < 0 ? pair : pair.slice(0, j)); const v = j < 0 ? '' : decodeURIComponent(pair.slice(j + 1).replace(/\+/g, ' ')); q[k] = v; } return { path: base, q }; }
  function fmtCookies(jar) { return Object.keys(jar).map(k => k + '=' + jar[k]).join('; '); }
  function parseCookieHeader(s) { const o = {}; for (const part of (s || '').split(';')) { const t = part.trim(); if (!t) continue; const i = t.indexOf('='); if (i < 0) continue; o[t.slice(0, i).trim()] = t.slice(i + 1).trim(); } return o; }
  function normPath(p) { const out = []; for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); } return '/' + out.join('/'); }
  function parseHeaderLines(text) { const h = {}; for (const line of (text || '').split('\n')) { const t = line.trim(); if (!t) continue; const i = t.indexOf(':'); if (i < 0) continue; h[t.slice(0, i).trim()] = t.slice(i + 1).trim(); } return h; }
  // 'price_a*qty_a+price_b*qty_b' over the form fields -> a number rounded to cents (NaN if a field is missing or not a number)
  function formTotal(form, expr) { let t = 0; for (const term of expr.split('+')) { let p = 1; for (const k of term.split('*')) { const v = (form[k.trim()] || '').trim(); if (!v || isNaN(Number(v))) return NaN; p *= Number(v); } t += p; } return Math.round(t * 100) / 100; }

  /* ---------------- the server ---------------- */
  // spec: { host, start:{method,path}, flag, routes:[ {method, path, when?, setCookie?, status?, headers?, body, redirect?, serve?} ] }
  // when: { cookie:{name:val}, header:{name:val}, query:{k:v}, bodyParam:{k:v}, bodyParamAtMost:{k:number}, bodyTotalAtMost:{'a*b+c*d':number}, pathIncludes:'..' }
  // placeholders: {flag} {cookie:k} {query:k} {form:k} {header:K} {file:path|body} {total:a*b+c*d} (form fields multiplied and added, 2 decimals)
  // serve: { param, dir, files:{'/abs/path':text}, missing } reads files[dir + '/' + query[param]] with ../ resolved like cd; fills {file:path} {file:body}
  class Server {
    constructor(spec) { this.spec = spec; this.jar = {}; (spec.initialCookies || null) && Object.assign(this.jar, spec.initialCookies); }
    matchWhen(when, req) {
      if (!when) return true;
      if (when.cookie) for (const k in when.cookie) if ((req.cookies[k] == null ? '' : String(req.cookies[k])) !== String(when.cookie[k])) return false;
      if (when.cookieSet) for (const k of when.cookieSet) if (req.cookies[k] == null) return false;
      if (when.header) { const H = lc(req.headers); for (const k in when.header) if ((H[k.toLowerCase()] || '') !== when.header[k]) return false; }
      if (when.query) for (const k in when.query) if ((req.query[k] || '') !== when.query[k]) return false;
      if (when.queryIncludes) for (const k in when.queryIncludes) if (((req.query[k] || '')).indexOf(when.queryIncludes[k]) < 0) return false;
      if (when.bodyParam) for (const k in when.bodyParam) if ((req.form[k] || '') !== when.bodyParam[k]) return false;
      if (when.bodyParamAtMost) for (const k in when.bodyParamAtMost) { const v = (req.form[k] || '').trim(); if (!v || isNaN(Number(v)) || Number(v) > when.bodyParamAtMost[k]) return false; }
      if (when.bodyTotalAtMost) for (const k in when.bodyTotalAtMost) { const t = formTotal(req.form, k); if (isNaN(t) || t > when.bodyTotalAtMost[k]) return false; }
      if (when.pathIncludes && req.path.indexOf(when.pathIncludes) < 0) return false;
      return true;
    }
    fill(s, req) {
      const file = req.file || {};
      return String(s == null ? '' : s)
        .replace(/\{file:(path|body)\}/g, (m, k) => file[k] == null ? '' : file[k])
        .replace(/\{flag\}/g, this.spec.flag || '')
        .replace(/\{cookie:([^}]+)\}/g, (m, k) => req.cookies[k] == null ? '' : req.cookies[k])
        .replace(/\{query:([^}]+)\}/g, (m, k) => req.query[k] == null ? '' : req.query[k])
        .replace(/\{form:([^}]+)\}/g, (m, k) => req.form[k] == null ? '' : req.form[k])
        .replace(/\{total:([^}]+)\}/g, (m, k) => { const t = formTotal(req.form, k); return isNaN(t) ? '?' : t.toFixed(2); })
        .replace(/\{header:([^}]+)\}/g, (m, k) => lc(req.headers)[k.toLowerCase()] || '');
    }
    // raw: {method, url, path, headers:{}, body}  -> record {req, res}
    handle(raw) {
      const pq = parseQuery(raw.path);
      const headers = raw.headers || {};
      const H = lc(headers);
      const cookies = H.cookie ? parseCookieHeader(H.cookie) : Object.assign({}, this.jar);
      const form = {}; if (raw.body) { const b = parseQuery('?' + raw.body).q; Object.assign(form, b); }
      const req = { method: (raw.method || 'GET').toUpperCase(), path: pq.path, rawPath: raw.path, url: raw.url, host: this.spec.host, headers: Object.assign({}, headers), cookies, query: pq.q, form, body: raw.body || '' };
      // find candidate routes: same path, method matches (or route has no method)
      const cands = (this.spec.routes || []).filter(r => {
        const rp = r.path; const pathOk = r.pathMatch === 'includes' ? req.path.indexOf(rp) >= 0 : (r.pathMatch === 'prefix' ? req.path.indexOf(rp) === 0 : req.path === rp);
        const methOk = !r.method || r.method.toUpperCase() === req.method;
        return pathOk && methOk;
      });
      let route = cands.find(r => this.matchWhen(r.when, req));
      if (!route) route = cands.find(r => !r.when);
      let res;
      if (!route) {
        res = { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'text/html' }, body: `<!doctype html><title>404</title><h1>404 Not Found</h1><p>No page at <code>${req.path}</code> on ${this.spec.host}.</p>` };
      } else {
        const setCookies = {};
        if (route.setCookie) for (const k in route.setCookie) { const v = this.fill(route.setCookie[k], req); setCookies[k] = v; this.jar[k] = v; }
        let status = route.status, body = route.body;
        if (route.serve) { const sv = route.serve; const path = normPath(sv.dir + '/' + (req.query[sv.param] || '')); const text = (sv.files || {})[path]; req.file = { path, body: text }; if (text == null) { status = 404; body = sv.missing; } }
        const resHeaders = Object.assign({ 'Content-Type': route.redirect ? 'text/html' : 'text/html; charset=utf-8', 'Server': this.spec.server || 'FlippedHTTP/1.0' }, route.headers || {});
        for (const k in route.headers || {}) resHeaders[k] = this.fill(route.headers[k], req);
        for (const k in setCookies) resHeaders['Set-Cookie'] = (resHeaders['Set-Cookie'] ? resHeaders['Set-Cookie'] + '\n' : '') + k + '=' + setCookies[k] + '; Path=/';
        if (route.redirect) { resHeaders['Location'] = route.redirect; res = { status: route.status || 302, statusText: 'Found', headers: resHeaders, setCookies, body: this.fill(route.redirectBody || `<!doctype html><title>Redirecting</title><p>Redirecting to <a href="${route.redirect}">${route.redirect}</a></p>`, req), location: route.redirect }; }
        else res = { status: status || 200, statusText: status === 404 ? 'Not Found' : (route.statusText || 'OK'), headers: resHeaders, setCookies, body: this.fill(body, req) };
      }
      // if request carried its own Cookie header, do not also fold jar (already used); else keep jar as the sent cookies
      if (!H.cookie) req.cookies = Object.assign({}, cookies);
      return { req, res, t: Date.now() };
    }
  }

  /* ---------------- the workspace (mini-browser + a DevTools-style Network panel) ---------------- */
  // The inspector copies Chrome DevTools' Network tab (light theme) so what kids learn here transfers to F12 in real Chrome.
  // Chrome cannot edit a request; "Edit and Resend" is borrowed from Firefox/Edge and opens in the detail pane.
  const ICON = {
    rec: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#d93025"/></svg>',
    clear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.3 11.7l7.4-7.4" stroke="currentColor" stroke-width="1.5"/></svg>',
    funnel: '<svg viewBox="0 0 16 16"><path d="M2.5 3h11l-4.3 5.2v4.3l-2.4 1.2V8.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 10.2l3.3 3.3" stroke="currentColor" stroke-width="1.6"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5"/></svg>',
    inspect: '<svg viewBox="0 0 16 16"><path d="M13 7V3H3v10h4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 8l6.5 2.4-2.7 1.1-1.1 2.7z" fill="currentColor"/></svg>',
    device: '<svg viewBox="0 0 16 16"><rect x="4.5" y="2" width="7" height="12" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12h2" stroke="currentColor" stroke-width="1.3"/></svg>',
    gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.4"/></svg>',
    dots: '<svg viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.5" r="1.3" fill="currentColor"/></svg>',
    doc: '<svg viewBox="0 0 16 16"><path d="M4 1.8h5.2L12.5 5v9.2H4z" fill="#fff" stroke="#5f6368" stroke-width="1.1" stroke-linejoin="round"/><path d="M9 2v3.3h3.3" fill="none" stroke="#5f6368" stroke-width="1.1"/></svg>',
    fetch: '<svg viewBox="0 0 16 16"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.1"/><path d="M6.4 5.2c-1 0-1.2.5-1.2 1.3v.6c0 .5-.3.9-.9.9.6 0 .9.4.9.9v.6c0 .8.2 1.3 1.2 1.3M9.6 5.2c1 0 1.2.5 1.2 1.3v.6c0 .5.3.9.9.9-.6 0-.9.4-.9.9v.6c0 .8-.2 1.3-1.2 1.3" fill="none" stroke="#1a73e8" stroke-width="1"/></svg>',
    resend: '<svg viewBox="0 0 16 16"><path d="M12.5 7.5A4.6 4.6 0 1 0 11 11.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.6 3.4v4.4H9.2z" fill="currentColor"/></svg>',
    pencil: '<svg viewBox="0 0 16 16"><path d="M3 11.2V13h1.8l7-7-1.8-1.8zM11 3.2l1.8 1.8 1-1-1.8-1.8z" fill="currentColor"/></svg>'
  };
  function ic(name, cls) { const s = el('span', 'px-ic' + (cls ? ' ' + cls : '')); s.innerHTML = ICON[name]; return s; }
  function bytes(s) { return new TextEncoder().encode(String(s || '')).length; }
  function fmtSize(n) { return n < 1000 ? n + ' B' : (n / 1000).toFixed(1) + ' kB'; }
  function stClass(st) { return st >= 200 && st < 300 ? 'ok' : st >= 300 && st < 400 ? 'redir' : 'err'; }
  function toPath(v) { v = String(v || '').trim().replace(/^https?:\/\/[^/?#]*/i, ''); return !v ? '/' : v.startsWith('/') ? v : '/' + v; }
  // Chrome's Name column: the last path segment plus the query; the site root shows the host
  function nameOf(rawPath, host) { const i = rawPath.indexOf('?'); const p = i < 0 ? rawPath : rawPath.slice(0, i), q = i < 0 ? '' : rawPath.slice(i); const segs = p.split('/').filter(Boolean); return (!segs.length ? host : segs[segs.length - 1] + (p.endsWith('/') ? '/' : '')) + q; }
  // tiny HTML highlighter for the Response tab -> [[class, text], ...] (Chrome's colors: tags purple, attrs brown, values blue, comments green)
  function hlHtml(src) {
    const out = [], re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z!][^>]*>?)|([^<]+|<)/g; let m;
    while ((m = re.exec(src))) {
      if (m[1]) { out.push(['t-com', m[1]]); continue; }
      if (!m[2]) { out.push(['', m[3]]); continue; }
      const mm = /^(<\/?!?)([\w:-]*)([\s\S]*?)(\/?>)?$/.exec(m[2]); out.push(['t-tag', mm[1] + mm[2]]);
      const rest = mm[3], ar = /([^\s=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'>]+)?/g; let a, last = 0;
      while ((a = ar.exec(rest))) { if (a.index > last) out.push(['', rest.slice(last, a.index)]); out.push(['t-att', a[1]]); if (a[2]) out.push(['', a[2]]); if (a[3]) out.push(['t-val', a[3]]); last = ar.lastIndex; }
      if (last < rest.length) out.push(['', rest.slice(last)]); if (mm[4]) out.push(['t-tag', mm[4]]);
      if (/^(script|style)$/i.test(mm[2]) && mm[1] === '<') { const end = src.toLowerCase().indexOf('</' + mm[2].toLowerCase(), re.lastIndex); const stop = end < 0 ? src.length : end; if (stop > re.lastIndex) out.push(['', src.slice(re.lastIndex, stop)]); re.lastIndex = stop; }
    }
    return out;
  }
  function codeLines(box, segs) { let line = el('div', 'l'); box.append(line); for (const [c, t] of segs) t.split('\n').forEach((p, j) => { if (j) { line = el('div', 'l'); box.append(line); } if (p) line.append(c ? el('span', c, p) : document.createTextNode(p)); }); }
  const TYPES = [['all', 'All'], ['document', 'Doc'], ['fetch', 'Fetch/XHR'], ['css', 'CSS'], ['js', 'JS'], ['font', 'Font', 1], ['img', 'Img'], ['media', 'Media', 1], ['manifest', 'Manifest', 0], ['ws', 'WS', 0], ['wasm', 'Wasm', 0], ['other', 'Other', 0]];

  class Proxy {
    constructor(container, spec, opts) {
      this.spec = spec; this.server = new Server(spec); this.opts = opts || {};
      this.log = []; this.selected = -1; this.followRedirects = true;
      this.tab = 'headers'; this.editing = false; this.typeFilter = 'all'; this.closed = {}; this.raw = {};
      this.root = el('div', 'px'); container.appendChild(this.root);
      this.build();
      const start = spec.start || { method: 'GET', path: '/' };
      this.navigate(start.path || '/', { method: start.method || 'GET' });
    }
    build() {
      // left: mini browser
      const browser = el('div', 'px-browser');
      const bar = el('div', 'px-bar');
      this.back = el('button', 'px-nav', '‹'); this.reload = el('button', 'px-nav', '⟳');
      this.addr = el('input', 'px-addr'); this.addr.spellcheck = false; this.addr.autocomplete = 'off';
      this.go = el('button', 'px-go', 'Go');
      bar.append(this.back, this.reload, this.addr, this.go);
      this.page = el('div', 'px-page');
      browser.append(bar, this.page);
      // right: DevTools. row 1 = the panel tabs (only Network is real), row 2 = the Network toolbar, row 3 = the filter bar
      const insp = el('div', 'px-insp');
      const tabs = el('div', 'px-dt-tabs');
      tabs.append(ic('inspect', 'px-deco'), ic('device', 'px-deco'), el('span', 'px-vsep'));
      [['Elements'], ['Console'], ['Sources'], ['Network', 1], ['Performance', 0, 'px-n2'], ['Memory', 0, 'px-n2'], ['Application', 0, 'px-n1']].forEach(([t, on, c]) => { const s = el('span', 'px-dt-tab' + (on ? ' on' : ' off') + (c ? ' ' + c : ''), t); if (!on) s.title = 'Only the Network tab is part of this lab. Press F12 in real Chrome for the rest.'; tabs.append(s); });
      tabs.append(el('span', 'px-sp'), ic('gear', 'px-deco'), ic('dots', 'px-deco'));
      const tb = el('div', 'px-tb');
      const recBtn = el('span', 'px-tbtn px-rec'); recBtn.innerHTML = ICON.rec; recBtn.title = 'Recording network log';
      this.clearBtn = el('button', 'px-tbtn px-clear'); this.clearBtn.innerHTML = ICON.clear; this.clearBtn.title = 'Clear network log';
      const pres = el('label', 'px-cb'); const pcb = el('input'); pcb.type = 'checkbox'; pcb.checked = true; pres.append(pcb, document.createTextNode('Preserve log'));
      const dis = el('label', 'px-cb px-n1'); const dcb = el('input'); dcb.type = 'checkbox'; dis.append(dcb, document.createTextNode('Disable cache'));
      this.earTb = el('button', 'px-ear px-ear-tb'); this.earTb.innerHTML = ICON.pencil + '<span>Edit and Resend</span>'; this.earTb.title = 'Edit the selected request and send your own version';
      tb.append(recBtn, this.clearBtn, el('span', 'px-vsep'), ic('funnel', 'px-deco px-on'), ic('search', 'px-deco'), el('span', 'px-vsep'), pres, dis, el('span', 'px-vsep px-n1'), el('span', 'px-throt px-n1', 'No throttling ▾'), el('span', 'px-sp'), this.earTb);
      const fb = el('div', 'px-fb');
      const fwrap = el('div', 'px-fwrap'); this.filter = el('input', 'px-filter'); this.filter.placeholder = 'Filter'; this.filter.spellcheck = false; this.filter.autocomplete = 'off'; fwrap.append(ic('funnel'), this.filter);
      const inv = el('label', 'px-cb px-n2'); this.invert = el('input'); this.invert.type = 'checkbox'; inv.append(this.invert, document.createTextNode('Invert'));
      this.chips = el('div', 'px-chips'); TYPES.forEach(([k, t, n]) => { const c = el('button', 'px-chip' + (n === 1 ? ' px-n1' : n === 0 ? ' px-n0' : ''), t); c.dataset.type = k; c.addEventListener('click', () => { this.typeFilter = k; this.renderList(); }); this.chips.append(c); });
      fb.append(fwrap, inv, el('span', 'px-vsep'), this.chips);
      // body: request table (left) + detail pane (right, Chrome's split)
      this.main = el('div', 'px-main');
      const left = el('div', 'px-left');
      this.list = el('div', 'px-list'); this.list.tabIndex = 0;
      const tbl = el('table', 'px-tbl'); const thead = el('thead'); const hr = el('tr');
      [['c-name', 'Name'], ['c-st', 'Status'], ['c-ty', 'Type'], ['c-sz', 'Size'], ['c-tm', 'Time']].forEach(([c, t]) => hr.append(el('th', c, t)));
      thead.append(hr); this.tbody = el('tbody'); tbl.append(thead, this.tbody);
      this.empty = el('div', 'px-empty', 'Recording network activity… Click a link in the browser or reload (⟳) to record a request.');
      this.list.append(tbl, this.empty); left.append(this.list);
      this.detail = el('div', 'px-detail');
      this.main.append(left, this.detail);
      this.foot = el('div', 'px-foot');
      insp.append(tabs, tb, fb, this.main, this.foot);
      this.root.append(browser, insp);
      // events
      this.go.addEventListener('click', () => this.addressGo());
      this.addr.addEventListener('keydown', e => { if (e.key === 'Enter') this.addressGo(); });
      this.reload.addEventListener('click', () => this.navigate(this.curPath, { method: 'GET' }));
      this.back.addEventListener('click', () => { if (this.history && this.history.length > 1) { this.history.pop(); const p = this.history[this.history.length - 1]; this.navigate(p, { method: 'GET', noPush: true }); } });
      this.clearBtn.addEventListener('click', () => { this.log = []; this.selected = -1; this.editing = false; this.renderList(); this.renderDetail(); });
      this.earTb.addEventListener('click', () => this.openEdit());
      this.filter.addEventListener('input', () => this.renderList()); this.invert.addEventListener('change', () => this.renderList());
      this.list.addEventListener('keydown', e => { if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault(); const vis = this.visible(); if (!vis.length) return; const at = vis.indexOf(this.selected); this.select(vis[Math.max(0, Math.min(vis.length - 1, at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)))]); });
      document.addEventListener('mousedown', e => { if (this.menuEl && !this.menuEl.contains(e.target)) this.closeMenu(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') this.closeMenu(); });
      window.addEventListener('scroll', () => this.closeMenu(), true); window.addEventListener('blur', () => this.closeMenu());
      this.page.addEventListener('click', e => { const a = e.target.closest('a[href]'); if (!a) return; e.preventDefault(); const href = a.getAttribute('href'); if (/^https?:/i.test(href)) { this.toast('that link leaves this site; the inspector only follows links on ' + this.spec.host); return; } this.navigate(href, { method: 'GET' }); });
      this.page.addEventListener('submit', e => { e.preventDefault(); const f = e.target.closest('form'); if (!f) return; const method = (f.getAttribute('method') || 'GET').toUpperCase(); const action = f.getAttribute('action') || this.curPath; const data = []; for (const el of f.elements) { if (!el.name) continue; if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue; data.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value)); } const qs = data.join('&'); if (method === 'GET') this.navigate(action + (qs ? '?' + qs : ''), { method: 'GET' }); else this.navigate(action, { method: 'POST', body: qs }); });
      this.history = [];
    }
    addressGo() { this.navigate(toPath(this.addr.value), { method: 'GET' }); }
    toast(m) { if (this.opts.toast) this.opts.toast(m); }
    // issue a request through the server and log it. Navigations keep the current selection (like Chrome);
    // a resend selects its new row so its Headers/Response are on screen.
    send(raw, isNav) {
      const rec = this.server.handle(raw);
      rec.raw = raw; rec.nav = !!isNav; rec.type = isNav ? 'document' : 'fetch'; rec.ms = 3 + Math.floor(Math.random() * 28);
      rec.bodySize = bytes(rec.res.body); rec.size = rec.bodySize + bytes(this.statusLine(rec) + '\r\n' + this.resHeaders(rec).map(([k, v]) => k + ': ' + v + '\r\n').join('') + '\r\n');
      this.log.push(rec);
      if (!isNav) { this.selected = this.log.length - 1; this.editing = false; if (!/^(response|preview)$/.test(this.tab)) this.tab = 'headers'; }
      this.renderList(); if (!isNav) this.renderDetail();
      return rec;
    }
    navigate(path, opt) {
      opt = opt || {};
      const raw = { method: opt.method || 'GET', path, url: 'http://' + this.spec.host + path, headers: Object.assign({ 'User-Agent': 'FlippedBrowser/1.0' }, opt.headers || {}), body: opt.body || '' };
      let rec = this.send(raw, true);
      // follow redirects like a browser; each hop is its own row
      let hops = 0;
      while (this.followRedirects && rec.res.location && hops < 5) { hops++; const loc = rec.res.location; rec = this.send({ method: 'GET', path: loc, url: 'http://' + this.spec.host + loc, headers: {}, body: '' }, true); }
      this.curPath = rec.req.path + (rec.raw.path.indexOf('?') >= 0 && rec.req.method === 'GET' ? rec.raw.path.slice(rec.raw.path.indexOf('?')) : '');
      this.addr.value = 'http://' + this.spec.host + (rec.raw.path.startsWith('/') ? rec.raw.path : '/' + rec.raw.path);
      if (!opt.noPush) { this.history.push(rec.raw.path); }
      this.renderPage(rec.res);
      return rec;
    }
    renderPage(res) {
      this.page.innerHTML = '';
      const doc = el('div', 'px-doc');
      // render the body as HTML (scripts in innerHTML never execute)
      doc.innerHTML = res.body || '';
      this.page.appendChild(doc);
    }
    /* ---- what a record looks like on the wire ---- */
    statusLine(rec) { return 'HTTP/1.1 ' + rec.res.status + ' ' + (rec.res.statusText || ''); }
    urlOf(rec) { const p = rec.req.rawPath || rec.req.path; return 'http://' + this.spec.host + (p.startsWith('/') ? p : '/' + p); }
    // request headers as sent: one Host line (the student's own if they typed one), the Cookie line, then the rest
    reqHeaders(rec) { const H = rec.req.headers || {}; const L = lc(H); const out = [['Host', L.host || this.spec.host]]; if (rec.req.cookies && Object.keys(rec.req.cookies).length) out.push(['Cookie', fmtCookies(rec.req.cookies)]); for (const k in H) if (!/^(host|cookie)$/i.test(k)) out.push([k, H[k]]); return out; }
    resHeaders(rec) { const out = []; for (const k in rec.res.headers) for (const v of String(rec.res.headers[k]).split('\n')) out.push([k, v]); return out; }
    visible() { const f = this.filter.value.trim().toLowerCase(), inv = this.invert.checked, ty = this.typeFilter; const r = []; this.log.forEach((rec, i) => { const hit = !f || ((rec.req.rawPath || rec.req.path).toLowerCase().indexOf(f) >= 0) !== inv; if (hit && (ty === 'all' || ty === rec.type)) r.push(i); }); return r; }
    select(i) { this.selected = i; this.editing = false; this.renderList(); this.renderDetail(); }
    /* ---- the request table ---- */
    renderList() {
      this.tbody.innerHTML = '';
      const vis = this.visible(); let xfer = 0, res = 0;
      for (const i of vis) {
        const rec = this.log[i], st = rec.res.status, sc = stClass(st), path = rec.req.rawPath || rec.req.path;
        const row = el('tr', 'px-row px-' + sc + (i === this.selected ? ' on' : '') + (rec.nav ? '' : ' resent'));
        row.dataset.path = path; row.dataset.i = i; row.title = rec.req.method + ' ' + this.urlOf(rec) + (rec.nav ? '' : '\n(edited and resent by you)');
        const nm = el('td', 'c-name'); nm.append(ic(rec.nav ? 'doc' : 'fetch', 'px-ti')); if (!rec.nav) nm.append(ic('resend', 'px-rs')); nm.append(el('span', 'px-p', nameOf(path, this.spec.host)));
        if (rec.req.method !== 'GET') nm.append(el('span', 'px-mth', rec.req.method));
        row.append(nm, el('td', 'c-st', String(st)), el('td', 'c-ty', rec.type), el('td', 'c-sz', fmtSize(rec.size)), el('td', 'c-tm', rec.ms + ' ms'));
        row.addEventListener('click', () => this.select(i));
        row.addEventListener('contextmenu', e => this.menu(e, i));
        this.tbody.appendChild(row);
        xfer += rec.size; res += rec.bodySize;
      }
      this.empty.style.display = this.log.length ? 'none' : '';
      for (const c of this.chips.children) c.classList.toggle('on', c.dataset.type === this.typeFilter);
      this.earTb.disabled = !this.log[this.selected]; this.earTb.title = this.earTb.disabled ? 'Click a request row first, then Edit and Resend it' : 'Edit the selected request and send your own version';
      this.foot.innerHTML = '';
      [(vis.length === this.log.length ? '' : vis.length + ' / ') + this.log.length + ' request' + (this.log.length === 1 ? '' : 's'), fmtSize(xfer) + ' transferred', fmtSize(res) + ' resources'].forEach((t, j) => { if (j) this.foot.append(el('span', 'px-fsep')); this.foot.append(el('span', '', t)); });
      const on = this.tbody.querySelector('.px-row.on');
      if (on) on.scrollIntoView({ block: 'nearest' }); else this.list.scrollTop = this.list.scrollHeight;
    }
    menu(e, i) {
      e.preventDefault(); this.closeMenu(); if (this.selected !== i) this.select(i);
      const m = el('div', 'px-menu'); const rec = this.log[i];
      const item = (t, fn, cls) => { const d = el('div', 'px-mi' + (cls ? ' ' + cls : '')); d.innerHTML = t; d.addEventListener('click', () => { this.closeMenu(); fn(); }); m.append(d); };
      item(ICON.pencil + '<span>Edit and Resend</span>', () => this.openEdit(), 'px-mi-ear');
      m.append(el('div', 'px-msep'));
      item('<span>Copy URL</span>', () => { const u = this.urlOf(rec); (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => this.toast('URL copied'), () => prompt('Copy this URL:', u)); });
      item('<span>Clear network log</span>', () => this.clearBtn.click());
      document.body.append(m); this.menuEl = m;
      const r = m.getBoundingClientRect(); m.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + 'px'; m.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + 'px';
    }
    closeMenu() { if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; } }
    openEdit() { if (!this.log[this.selected]) return; this.editing = true; this.renderList(); this.renderDetail(); const f = this.detail.querySelector('.px-f-hdr'); if (f) f.focus(); }
    /* ---- the detail pane ---- */
    renderDetail() {
      this.detail.innerHTML = '';
      const rec = this.log[this.selected]; this.main.classList.toggle('open', !!rec); if (!rec) return;
      const head = el('div', 'px-dh'); const x = el('button', 'px-x'); x.innerHTML = ICON.close; x.title = 'Close';
      x.addEventListener('click', () => { if (this.editing) { this.editing = false; this.renderDetail(); } else this.select(-1); });
      head.append(x);
      const pane = el('div', 'px-dp');
      if (this.editing) { head.append(el('span', 'px-tab on', 'Edit and Resend')); this.renderEdit(pane, rec); this.detail.append(head, pane); return; }
      const hasPayload = Object.keys(rec.req.query || {}).length || rec.req.body;
      const tabs = [['headers', 'Headers', 'The status line and every header that went out and came back']].concat(hasPayload ? [['payload', 'Payload', 'The query string and form data this request carried']] : [])
        .concat([['preview', 'Preview', 'The response drawn as a page (what a browser shows)'], ['response', 'Response', 'Exactly what the server sent back, as text, including comments the page never draws'], ['cookies', 'Cookies', 'Cookies sent with the request and set by the response']]);
      const tab = tabs.some(t => t[0] === this.tab) ? this.tab : 'headers';
      for (const [k, t, tip] of tabs) { const b = el('button', 'px-tab' + (k === tab ? ' on' : ''), t); b.dataset.tab = k; b.title = tip; b.addEventListener('click', () => { this.tab = k; this.renderDetail(); }); head.append(b); }
      const ear = el('button', 'px-ear'); ear.innerHTML = ICON.pencil + '<span>Edit and Resend</span>'; ear.title = 'Change this request and send your own version';
      ear.addEventListener('click', () => this.openEdit()); head.append(el('span', 'px-sp'), ear);
      ({ headers: this.tabHeaders, payload: this.tabPayload, preview: this.tabPreview, response: this.tabResponse, cookies: this.tabCookies })[tab].call(this, pane, rec);
      this.detail.append(head, pane);
    }
    // a collapsible Chrome section: "▼ Title" and name/value rows; toggle = 'raw' (Raw checkbox) or 'source' (view source link)
    section(pane, key, title, rows, rawText, toggle) {
      const open = !this.closed[key], raw = !!this.raw[key];
      const s = el('div', 'px-hsec' + (open ? ' open' : '')); s.dataset.sec = key;
      const h = el('div', 'px-hsec-h'); h.append(el('span', 'px-tri'), el('span', 'px-hsec-t', title));
      if (rawText != null && toggle === 'raw') { const lab = el('label', 'px-raw'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = raw; lab.append(cb, document.createTextNode('Raw')); lab.addEventListener('click', e => e.stopPropagation()); cb.addEventListener('change', () => { this.raw[key] = cb.checked; this.renderDetail(); }); h.append(el('span', 'px-sp'), lab); }
      if (rawText != null && toggle === 'source') { const v = el('button', 'px-vs', raw ? 'view parsed' : 'view source'); v.addEventListener('click', e => { e.stopPropagation(); this.raw[key] = !raw; this.renderDetail(); }); h.append(v); }
      h.addEventListener('click', () => { this.closed[key] = open; this.renderDetail(); });
      s.append(h);
      if (open && raw && rawText != null) s.append(el('pre', 'px-rawtxt', rawText));
      else if (open) { const g = el('div', 'px-kv'); for (const [k, v] of rows) { const r = el('div', 'px-kvr'); const vv = el('div', 'px-v'); if (v instanceof Node) vv.append(v); else vv.textContent = v; r.append(el('div', 'px-k', k), vv); g.append(r); } if (!rows.length) g.append(el('div', 'px-none', '(none)')); s.append(g); }
      pane.append(s);
    }
    tabHeaders(pane, rec) {
      const st = rec.res.status; const sc = el('span', 'px-sc'); sc.append(el('span', 'px-dot px-' + stClass(st)), document.createTextNode(st + ' ' + (rec.res.statusText || '')));
      this.section(pane, 'gen', 'General', [['Request URL', this.urlOf(rec)], ['Request Method', rec.req.method], ['Status Code', sc], ['Remote Address', this.spec.host + ':80'], ['Referrer Policy', 'strict-origin-when-cross-origin']]);
      const rh = this.resHeaders(rec), qh = this.reqHeaders(rec);
      this.section(pane, 'res', 'Response Headers', rh, this.statusLine(rec) + '\n' + rh.map(([k, v]) => k + ': ' + v).join('\n'), 'raw');
      this.section(pane, 'req', 'Request Headers', qh, rec.req.method + ' ' + (rec.req.rawPath || rec.req.path) + ' HTTP/1.1\n' + qh.map(([k, v]) => k + ': ' + v).join('\n') + (rec.req.body ? '\n\n' + rec.req.body : ''), 'raw');
    }
    tabPayload(pane, rec) {
      const q = rec.req.query || {}, p = rec.req.rawPath || '';
      if (Object.keys(q).length) this.section(pane, 'qs', 'Query String Parameters', Object.keys(q).map(k => [k, q[k]]), p.slice(p.indexOf('?') + 1), 'source');
      if (rec.req.body) this.section(pane, 'form', 'Form Data', Object.keys(rec.req.form || {}).map(k => [k, rec.req.form[k]]), rec.req.body, 'source');
    }
    tabPreview(pane, rec) {
      const body = rec.res.body || ''; if (!body) { pane.append(el('div', 'px-nodata', 'This request has no response data available.')); return; }
      if (!/html/i.test(lc(rec.res.headers)['content-type'] || 'html')) { pane.append(el('pre', 'px-prevtxt', body)); return; }
      const f = el('iframe', 'px-prev'); f.setAttribute('sandbox', ''); f.title = 'Preview';
      f.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:14px 16px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a2230}a{color:#1a5fb4}code{background:#eef1f5;padding:1px 4px;border-radius:3px}.card,.box{background:#f4f6f9;border:1px solid #dde3ea;border-radius:8px;padding:10px 12px;margin:8px 0}input,button{font:inherit;padding:5px 8px}</style>' + body;
      pane.append(f);
    }
    tabResponse(pane, rec) {
      const box = el('div', 'px-resb px-code'); const body = rec.res.body || '';
      if (!body) box.append(el('div', 'px-nodata', 'This request has no response data available.'));
      else codeLines(box, /html/i.test(lc(rec.res.headers)['content-type'] || 'html') ? hlHtml(body) : [['', body]]);
      pane.append(box);
    }
    tabCookies(pane, rec) {
      const tbl = (title, list) => { const s = el('div', 'px-cksec'); s.append(el('div', 'px-ck-h', title)); if (!list.length) { s.append(el('div', 'px-none', 'This request has no ' + title.toLowerCase() + '.')); pane.append(s); return; } const t = el('table', 'px-ck'); const hr = el('tr'); ['Name', 'Value', 'Domain', 'Path', 'Expires / Max-Age', 'Size'].forEach(h => hr.append(el('th', '', h))); t.append(hr); for (const [k, v] of list) { const r = el('tr'); [k, v, this.spec.host, '/', 'Session', String(k.length + String(v).length)].forEach((c, j) => { const td = el('td', j < 2 ? 'mono' : '', c); td.title = c; r.append(td); }); t.append(r); } s.append(t); pane.append(s); };
      const rc = rec.req.cookies || {}, sc = rec.res.setCookies || {};
      tbl('Request Cookies', Object.keys(rc).map(k => [k, rc[k]])); tbl('Response Cookies', Object.keys(sc).map(k => [k, sc[k]]));
    }
    // Edit and Resend (Firefox/Edge style): every part of the request is a field; Send logs a new row and draws the reply
    renderEdit(pane, rec) {
      const f = el('div', 'px-ed');
      f.append(el('div', 'px-ed-tip', 'Change any part of this request, then press Send. Your version shows up as a new row (marked with ↻) and the browser on the left draws the reply.'));
      const method = el('select', 'px-method'); ['GET', 'POST', 'PUT', 'HEAD', 'DELETE', 'OPTIONS'].forEach(m => { const o = el('option', '', m); o.value = m; if (m === rec.req.method) o.selected = true; method.appendChild(o); });
      const url = el('input', 'px-f-url'); url.value = this.urlOf(rec); url.spellcheck = false; url.autocomplete = 'off';
      const line = el('div', 'px-reqline'); line.append(method, url);
      const hdrs = el('textarea', 'px-f-hdr'); hdrs.spellcheck = false; hdrs.value = this.reqHeaders(rec).map(([k, v]) => k + ': ' + v).join('\n'); hdrs.rows = Math.max(4, hdrs.value.split('\n').length + 1);
      const body = el('textarea', 'px-f-body'); body.spellcheck = false; body.value = rec.req.body || ''; body.rows = 3; body.placeholder = 'name=value&other=value (used by POST)';
      const sendBtn = el('button', 'px-send', 'Send'); const cancel = el('button', 'px-cancel', 'Cancel');
      const go = () => { const path = toPath(url.value); const rec2 = this.send({ method: method.value, path, url: 'http://' + this.spec.host + path, headers: parseHeaderLines(hdrs.value), body: body.value }, false); if (!(rec2.res.location && this.followRedirects)) this.renderPage(rec2.res); /* a redirect is left for the student to read */ };
      sendBtn.addEventListener('click', go); cancel.addEventListener('click', () => { this.editing = false; this.renderList(); this.renderDetail(); });
      f.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
      const lbl = (t, s) => { const d = el('div', 'px-f-lbl', t); if (s) d.append(el('span', 'px-f-help', s)); return d; };
      const btns = el('div', 'px-ed-btns'); btns.append(sendBtn, cancel, el('span', 'px-f-help', 'Ctrl+Enter also sends'));
      f.append(lbl('Request', ' method and URL'), line, lbl('Headers', ' one per line, Name: value'), hdrs, lbl('Body', ' form data, e.g. for POST'), body, btns);
      pane.append(f);
    }
  }

  global.CTFProxy = { Proxy, Server };
})(window);
