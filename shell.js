/* CTF Practice · a small fake Linux shell that runs entirely in the browser.
   No DOM in this file: the terminal UI (term.js) gives it an "io" object with
   write(text), readLine(opts), edit(name, text) and an interrupt signal. */
(function (global) {
  'use strict';

  /* ---------------- utilities ---------------- */
  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function prng(seed) { let a = typeof seed === 'number' ? seed >>> 0 : hashStr(String(seed)); return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const WORDS = 'orbit lantern copper velvet marble thistle harbor meadow pixel saddle timber cinder willow ember falcon granite hollow ivory jasper kettle lumen nectar oyster pepper quartz ripple saffron tundra umber vapor walnut yonder zephyr anchor basil cobalt dune echo fable garnet hazel iris juniper kelp lotus mango nickel olive plum raven sage tulip vine wren amber birch cedar delta elm fern glade heron ink jade knoll lark moss nova opal pine reed slate thorn ultra vale wisp'.split(' ');
  function randWords(r, n) { const o = []; for (let i = 0; i < n; i++) o.push(WORDS[Math.floor(r() * WORDS.length)]); return o.join(' '); }
  function b64encode(s) { // s is a byte string (char codes 0..255)
    if (typeof btoa === 'function') return btoa(s);
    return Buffer.from(s, 'latin1').toString('base64');
  }
  function b64decode(s) {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
    if (typeof atob === 'function') return atob(clean);
    return Buffer.from(clean, 'base64').toString('latin1');
  }
  function utf8ToBytes(s) { // JS string -> byte string
    if (typeof TextEncoder !== 'undefined') { const u = new TextEncoder().encode(s); let o = ''; for (let i = 0; i < u.length; i++) o += String.fromCharCode(u[i]); return o; }
    return Buffer.from(s, 'utf8').toString('latin1');
  }
  function bytesToUtf8(b) {
    try {
      if (typeof TextDecoder !== 'undefined') { const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i) & 255; return new TextDecoder('utf-8', { fatal: true }).decode(u); }
      return Buffer.from(b, 'latin1').toString('utf8');
    } catch (e) { return b; }
  }
  function isPrintable(c) { return (c >= 32 && c < 127) || c === 9; }

  class Interrupt extends Error { constructor() { super('interrupt'); this.name = 'Interrupt'; } }
  class ExitShell extends Error { constructor(code) { super('exit'); this.name = 'ExitShell'; this.code = code || 0; } }

  /* ---------------- virtual file system ---------------- */
  // node: {t:'d', c:{}} | {t:'f', data, bin, x, kind, zip, prog, dirty}
  function dir(children) { return { t: 'd', c: children || {} }; }
  function file(data, opts) { return Object.assign({ t: 'f', data: data == null ? '' : String(data), bin: false, x: false, kind: 'text' }, opts || {}); }

  function materialize(seed, slug, home) {
    // seed is the compact JSON form from challenges.json; relative keys land in HOME, keys starting with / from the root
    const root = dir(); const fs = new FS(root); const homeDir = fs.mkdirp(home || '/home/ctf');
    function build(node, spec, prefix) {
      for (const key of Object.keys(spec)) {
        const v = spec[key];
        if (key.startsWith('/')) { const parent = fs.mkdirp(dirName(key)); if (key.endsWith('/')) { const d = dir(); parent.c[baseName(key.slice(0, -1))] = d; build(d, v || {}, key); } else parent.c[baseName(key)] = makeFile(v, slug + key); continue; }
        if (key.endsWith('/')) { const d = dir(); node.c[key.slice(0, -1)] = d; build(d, v || {}, prefix + key); continue; }
        node.c[key] = makeFile(v, slug + '/' + prefix + key);
      }
    }
    build(homeDir, seed || {}, '');
    return root;
  }
  function makeFile(v, seedKey) {
    if (typeof v === 'string') return file(v);
    if (!v || typeof v !== 'object') return file('');
    const type = v.$type || 'text';
    if (type === 'text') return file(v.content || '', { x: !!v.x, kind: v.kind || 'text' });
    if (type === 'py') return file(v.content || '', { kind: 'py' });
    if (type === 'sh') return file(v.content || '', { kind: 'sh', x: !!v.x });
    if (type === 'binary') return file(b64decode(v.b64 || ''), { bin: true, kind: v.kind || 'data', x: !!v.x, prog: v.prog, flag: v.flag, text: v.text, meta: v.meta, w: v.w, h: v.h, zipOffset: v.zipOffset, zip: v.zip ? zipTree(v.zip, seedKey) : undefined });
    if (type === 'exec') return file(fakeElf(seedKey, v.strings || []), { bin: true, kind: 'elf', x: !!v.x, prog: v.prog, flag: v.flag, text: v.text });
    if (type === 'zip') return file(fakeBytes(seedKey, 2000, 'PK'), { bin: true, kind: 'zip', zip: zipTree(v.entries || {}, seedKey) });
    if (type === 'gen') return genFile(v, seedKey);
    return file(v.content || '');
  }
  function zipTree(spec, seedKey) {
    if (spec && spec.$gen) return genTree(spec, seedKey);
    const root = dir();
    (function build(node, s) {
      for (const key of Object.keys(s)) {
        const v = s[key];
        if (key.endsWith('/')) { const d = dir(); node.c[key.slice(0, -1)] = d; build(d, v || {}); continue; }
        node.c[key] = makeFile(v, seedKey + '/' + key);
      }
    })(root, spec || {});
    return root;
  }
  function fakeBytes(seedKey, n, prefix) {
    const r = prng(seedKey); let o = prefix || '';
    for (let i = o.length; i < n; i++) o += String.fromCharCode(Math.floor(r() * 256));
    return o;
  }
  function fakeElf(seedKey, strings) {
    // ELF header + junk with the given printable strings scattered inside (for `strings`)
    const r = prng(seedKey + ':elf');
    let o = '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00\x01\x00\x00\x00';
    const parts = ['/lib64/ld-linux-x86-64.so.2', 'libc.so.6', 'puts', 'printf', '__libc_start_main', 'GLIBC_2.2.5', '.text', '.data', '.rodata', '.bss', '.symtab', '.strtab'].concat(strings || []);
    for (let p = 0; p < parts.length; p++) {
      const n = 40 + Math.floor(r() * 200);
      for (let i = 0; i < n; i++) o += String.fromCharCode(Math.floor(r() * 256));
      o += '\x00' + parts[p] + '\x00';
    }
    for (let i = 0; i < 600; i++) o += String.fromCharCode(Math.floor(r() * 256));
    return o;
  }
  function genFile(v, seedKey) {
    const g = v.gen || {};
    if (g.kind === 'repeat') {
      const lines = (g.text || '').split('\n'); const out = [];
      const total = (g.times || 1) * lines.length;
      const at = g.insertAt != null ? g.insertAt : Math.floor(total / 2);
      let k = 0;
      for (let t = 0; t < (g.times || 1); t++) for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (k === at && g.insertText) line = g.insertText.replace('{line}', line);
        out.push(line); k++;
      }
      return file(out.join('\n') + '\n');
    }
    if (g.kind === 'lines') {
      const r = prng(seedKey); const out = [];
      const n = g.count || 100; const at = g.insertAt != null ? g.insertAt : Math.floor(n / 2);
      for (let i = 0; i < n; i++) out.push(i === at && g.insertText ? g.insertText : randWords(r, 6 + Math.floor(r() * 6)));
      return file(out.join('\n') + '\n');
    }
    if (g.kind === 'noise') { // printable junk with strings hidden inside (strings/grep practice)
      const r = prng(seedKey); let o = '';
      const ins = g.strings || [];
      for (let p = 0; p <= ins.length; p++) {
        const n = 300 + Math.floor(r() * 500);
        for (let i = 0; i < n; i++) o += String.fromCharCode(Math.floor(r() * 256));
        if (p < ins.length) o += '\x00' + ins[p] + '\x00';
      }
      return file(o, { bin: true, kind: g.fileKind || 'data', x: !!v.x });
    }
    return file(v.content || '');
  }
  function genTree(spec, seedKey) {
    // $gen: {kind:'bigzip', top:'big-zip-files', folders:40, files:1200, flagFile:'...', flagLine:'...'}
    const r = prng(seedKey + ':tree'); const root = dir();
    const top = dir(); root.c[spec.top || 'files'] = top;
    const folders = []; const nf = spec.folders || 30;
    for (let i = 0; i < nf; i++) {
      let parent = i < 6 ? top : folders[Math.floor(r() * folders.length)];
      const name = 'folder_' + Math.floor(r() * 1e6).toString(36).padStart(5, '0');
      const d = dir(); parent.c[name] = d; folders.push(d);
    }
    const count = spec.files || 800; const flagAt = Math.floor(r() * count);
    for (let i = 0; i < count; i++) {
      const parent = folders[Math.floor(r() * folders.length)];
      const name = 'file_' + Math.floor(r() * 1e6).toString(36).padStart(5, '0') + '.txt';
      const lines = []; const n = 3 + Math.floor(r() * 5); const fl = Math.floor(r() * n);
      for (let j = 0; j < n; j++) lines.push(i === flagAt && j === fl && spec.flagLine ? spec.flagLine : randWords(r, 5 + Math.floor(r() * 8)));
      parent.c[name] = file(lines.join('\n') + '\n');
    }
    return root;
  }

  /* ---------------- path helpers ---------------- */
  function normalize(path) {
    const abs = path.startsWith('/');
    const parts = []; for (const p of path.split('/')) { if (!p || p === '.') continue; if (p === '..') { parts.pop(); continue; } parts.push(p); }
    return (abs ? '/' : '') + parts.join('/');
  }
  function joinPath(cwd, p) { if (p.startsWith('/')) return normalize(p); return normalize(cwd === '/' ? '/' + p : cwd + '/' + p); }
  function baseName(p) { const n = normalize(p); const i = n.lastIndexOf('/'); return i < 0 ? n : n.slice(i + 1); }
  function dirName(p) { const n = normalize(p); const i = n.lastIndexOf('/'); return i <= 0 ? '/' : n.slice(0, i); }

  class FS {
    constructor(root) { this.root = root || dir(); }
    get(path) { const n = normalize(path); if (n === '/' || n === '') return this.root; let node = this.root; for (const p of n.split('/').filter(Boolean)) { if (node.t !== 'd' || !node.c[p]) return null; node = node.c[p]; } return node; }
    mkdirp(path) { let node = this.root; for (const p of normalize(path).split('/').filter(Boolean)) { if (!node.c[p]) node.c[p] = dir(); node = node.c[p]; if (node.t !== 'd') return null; } return node; }
    write(path, data, opts) { const d = this.get(dirName(path)); if (!d || d.t !== 'd') return false; const name = baseName(path); const ex = d.c[name]; if (ex && ex.t === 'd') return false; if (ex) { ex.data = data; ex.dirty = true; if (opts) Object.assign(ex, opts); } else d.c[name] = Object.assign(file(data), opts || {}, { dirty: true }); return true; }
    remove(path) { const d = this.get(dirName(path)); if (!d || d.t !== 'd') return false; const name = baseName(path); if (!d.c[name]) return false; delete d.c[name]; return true; }
    walk(path, fn) { const n = this.get(path); if (!n) return; const rec = (node, p) => { fn(p, node); if (node.t === 'd') for (const k of Object.keys(node.c).sort()) rec(node.c[k], p === '/' ? '/' + k : p + '/' + k); }; rec(n, normalize(path) || '/'); }
    // user edits only (for persistence): [{path, data, bin, x, kind}], plus deletions are not tracked (reset button exists)
    dirtyFiles() { const out = []; this.walk('/', (p, n) => { if (n.t === 'f' && n.dirty) out.push({ path: p, data: n.bin ? b64encode(n.data) : n.data, bin: !!n.bin, x: !!n.x, kind: n.kind }); }); return out; }
    applyDirty(list) { for (const f of list || []) { this.mkdirp(dirName(f.path)); this.write(f.path, f.bin ? b64decode(f.data) : f.data, { bin: !!f.bin, x: !!f.x, kind: f.kind || 'text' }); } }
  }

  /* ---------------- tokenizer / parser ---------------- */
  // returns list of pipelines: [{cmds:[{words:[{v, q}], redir:{out, append}}], op:';'|'&&'}]
  function parseLine(line) {
    const seqs = []; let i = 0; const n = line.length;
    let cmds = [], words = [], cur = null, redirTarget = null, redir = null;
    function pushWord() { if (cur) { words.push(cur); cur = null; } }
    function pushCmd() { pushWord(); if (words.length || redir) { cmds.push({ words, redir }); } words = []; redir = null; }
    function pushSeq(op) { pushCmd(); if (cmds.length) seqs.push({ cmds, op }); cmds = []; }
    while (i < n) {
      const ch = line[i];
      if (ch === '#' && !cur) break;
      if (ch === ' ' || ch === '\t') { pushWord(); i++; continue; }
      if (ch === '|') { if (line[i + 1] === '|') { pushSeq('||'); i += 2; } else { pushCmd(); i++; } continue; }
      if (ch === ';') { pushSeq(';'); i++; continue; }
      if (ch === '&' && line[i + 1] === '&') { pushSeq('&&'); i += 2; continue; }
      if (ch === '>' ) { pushWord(); const append = line[i + 1] === '>'; i += append ? 2 : 1; while (line[i] === ' ') i++; let t = ''; while (i < n && !' \t|;&>'.includes(line[i])) t += line[i++]; redir = { target: t, append }; continue; }
      if (ch === '<') { i++; continue; } // input redirection: ignored (stdin files are not needed here)
      if (!cur) cur = { parts: [] };
      if (ch === "'") { let j = i + 1, s = ''; while (j < n && line[j] !== "'") s += line[j++]; cur.parts.push({ s, q: 'single' }); i = j + 1; continue; }
      if (ch === '"') { let j = i + 1, s = ''; while (j < n && line[j] !== '"') { if (line[j] === '\\' && j + 1 < n && '"\\$`'.includes(line[j + 1])) { s += line[j + 1]; j += 2; continue; } s += line[j++]; } cur.parts.push({ s, q: 'double' }); i = j + 1; continue; }
      if (ch === '\\' && i + 1 < n) { cur.parts.push({ s: line[i + 1], q: 'single' }); i += 2; continue; }
      let s = '';
      while (i < n && !' \t|;&><\'"\\'.includes(line[i])) {
        if (line[i] === '#') break;
        if (line[i] === '$' && line[i + 1] === '(') { let depth = 0; s += line[i++]; do { if (line[i] === '(') depth++; else if (line[i] === ')') depth--; s += line[i++]; } while (i < n && depth > 0); continue; }
        s += line[i++];
      }
      if (s) cur.parts.push({ s, q: null }); else i++;
    }
    pushSeq(null);
    return seqs;
  }

  /* ---------------- the shell ---------------- */
  const PROGRAMS = {}; // fake executables: name -> async (ctx, args) => code
  const SERVICES = {}; // nc / ssh service kinds: kind -> handler

  class Session {
    constructor(opts) {
      this.fs = opts.fs; this.user = opts.user || 'ctf'; this.host = opts.host || 'practice';
      this.home = opts.home || '/home/' + this.user; this.cwd = opts.cwd || this.home;
      this.restricted = !!opts.restricted; // only bash builtins
      this.env = Object.assign({ HOME: this.home, USER: this.user, SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' }, opts.env || {});
      this.history = []; this.lastCode = 0; this.challenge = opts.challenge || null;
      this.fs.mkdirp(this.home); this.fs.mkdirp('/tmp'); this.fs.mkdirp('/etc');
      if (!this.fs.get('/etc/hostname')) this.fs.write('/etc/hostname', this.host + '\n');
    }
    prompt() { const c = this.cwd === this.home ? '~' : this.cwd.startsWith(this.home + '/') ? '~' + this.cwd.slice(this.home.length) : this.cwd; return { user: this.user, host: this.host, cwd: c, text: `${this.user}@${this.host}:${c}$ ` }; }
  }

  class Shell {
    constructor(io) { this.io = io; this.pyBridge = null; }

    // ---- public: run one line in a session ----
    async runLine(session, line) {
      line = line.replace(/\r/g, '');
      if (line.trim()) session.history.push(line);
      let seqs;
      try { seqs = parseLine(line); } catch (e) { this.io.write('bash: syntax error\n'); return 1; }
      let code = 0, prevOp = null;
      for (const seq of seqs) {
        if (prevOp === '&&' && code !== 0) { prevOp = seq.op; continue; }
        if (prevOp === '||' && code === 0) { prevOp = seq.op; continue; }
        code = await this.runPipeline(session, seq.cmds, { write: s => this.io.write(s) });
        session.lastCode = code; session.env['?'] = String(code);
        prevOp = seq.op;
      }
      session.lastCode = code; session.env['?'] = String(code);
      return code;
    }

    async runPipeline(session, cmds, stdout) {
      let stdin = null; let code = 0;
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i]; const last = i === cmds.length - 1;
        let argv;
        try { argv = await this.expandWords(session, c.words); } catch (e) { if (e instanceof Interrupt) throw e; this.io.write('bash: ' + e.message + '\n'); return 1; }
        if (!argv.length && !c.redir) continue;
        let buf = '';
        const isPipe = !last; const toFile = !!c.redir;
        const ctx = {
          session, fs: session.fs, shell: this, stdin, hasStdin: stdin != null, isPipe: isPipe || toFile, io: this.io,
          out: s => { if (isPipe || toFile) buf += s; else stdout.write(s); },
          err: s => this.io.write(s),
          readLine: opts => this.io.readLine(opts),
        };
        if (!argv.length) { // bare redirection: create the file
          if (c.redir) session.fs.write(joinPath(session.cwd, c.redir.target), '');
          continue;
        }
        try { code = await this.exec(ctx, argv); }
        catch (e) { if (e instanceof Interrupt) { this.io.write('^C\n'); return 130; } if (e instanceof ExitShell) throw e; this.io.write('bash: ' + (e && e.message || e) + '\n'); code = 1; }
        if (toFile) {
          const p = joinPath(session.cwd, c.redir.target); const ex = session.fs.get(p);
          const data = c.redir.append && ex && ex.t === 'f' ? ex.data + buf : buf;
          if (!session.fs.write(p, data)) this.io.write(`bash: ${c.redir.target}: No such file or directory\n`);
          buf = '';
        }
        stdin = isPipe ? buf : null;
      }
      return code;
    }

    async expandWords(session, words) {
      const out = [];
      for (const w of words) {
        let text = ''; let hasGlob = false;
        for (const p of w.parts) {
          if (p.q === 'single') { text += p.s; continue; }
          let s = await this.substitute(session, p.s);
          if (p.q === null) {
            if (s.startsWith('~')) s = session.home + s.slice(1);
            if (/[*?]/.test(s)) hasGlob = true;
          }
          text += s;
        }
        if (hasGlob) { const m = this.glob(session, text); if (m.length) { out.push(...m); continue; } }
        out.push(text);
      }
      return out;
    }

    async substitute(session, s) {
      // $(<file), $(cmd), $VAR, ${VAR}
      let out = ''; let i = 0;
      while (i < s.length) {
        if (s[i] === '$' && s[i + 1] === '(') {
          let depth = 1, j = i + 2, inner = '';
          while (j < s.length && depth) { if (s[j] === '(') depth++; else if (s[j] === ')') { depth--; if (!depth) break; } inner += s[j]; j++; }
          i = j + 1;
          const t = inner.trim();
          if (t.startsWith('<')) {
            const p = joinPath(session.cwd, t.slice(1).trim().replace(/^~/, session.home)); const n = session.fs.get(p);
            if (!n || n.t !== 'f') { throw new Error(`${t.slice(1).trim()}: No such file or directory`); }
            out += n.data.replace(/\n+$/, '');
          } else {
            let buf = '';
            const seqs = parseLine(t);
            for (const seq of seqs) await this.runPipeline(session, seq.cmds, { write: x => { buf += x; } });
            out += buf.replace(/\n+$/, '');
          }
          continue;
        }
        if (s[i] === '$' && s[i + 1] === '{') { const j = s.indexOf('}', i); const name = s.slice(i + 2, j); out += session.env[name] || ''; i = j + 1; continue; }
        if (s[i] === '$' && /[A-Za-z_?]/.test(s[i + 1] || '')) { let j = i + 1, name = ''; if (s[j] === '?') { name = '?'; j++; } else while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) name += s[j++]; out += session.env[name] || ''; i = j; continue; }
        out += s[i++];
      }
      return out;
    }

    glob(session, pattern) {
      // supports * and ? in the last path component(s); matches each component
      const abs = pattern.startsWith('/');
      const comps = pattern.split('/').filter(Boolean);
      let cands = [{ path: abs ? '/' : session.cwd, rel: abs ? '/' : '' }];
      for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci]; const next = [];
        for (const c of cands) {
          const node = session.fs.get(c.path); if (!node || node.t !== 'd') continue;
          if (/[*?]/.test(comp)) {
            const re = new RegExp('^' + comp.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            for (const name of Object.keys(node.c).sort()) { if (name.startsWith('.') && !comp.startsWith('.')) continue; if (re.test(name)) next.push({ path: joinPath(c.path, name), rel: c.rel ? (c.rel.endsWith('/') ? c.rel + name : c.rel + '/' + name) : name }); }
          } else if (node.c[comp]) next.push({ path: joinPath(c.path, comp), rel: c.rel ? (c.rel.endsWith('/') ? c.rel + comp : c.rel + '/' + comp) : comp });
        }
        cands = next;
      }
      return cands.map(c => c.rel);
    }

    complete(session, line) {
      // returns {replace, options}: tab completion for the last word
      const m = line.match(/(^|\s)(\S*)$/); const word = m ? m[2] : '';
      const first = line.trim().indexOf(' ') < 0 && !line.endsWith(' ');
      let opts = [];
      if (first) { opts = Object.keys(this.builtins).concat(session.restricted ? [] : Object.keys(COMMANDS)).filter(c => c.startsWith(word)); return { word, options: Array.from(new Set(opts)).sort(), isDir: {} }; }
      const slash = word.lastIndexOf('/'); const dirPart = slash >= 0 ? word.slice(0, slash + 1) : ''; const base = word.slice(slash + 1);
      const dpath = joinPath(session.cwd, (dirPart || '.').replace(/^~/, session.home));
      const node = session.fs.get(dpath); const isDir = {};
      if (node && node.t === 'd') for (const name of Object.keys(node.c).sort()) { if (name.startsWith(base) && (base.startsWith('.') || !name.startsWith('.'))) { opts.push(dirPart + name); isDir[dirPart + name] = node.c[name].t === 'd'; } }
      return { word, options: opts, isDir };
    }

    async exec(ctx, argv) {
      const s = ctx.session; const name = argv[0]; const args = argv.slice(1);
      if (this.builtins[name]) return this.builtins[name].call(this, ctx, args);
      if (s.restricted) { ctx.err(`bash: ${name}: command not found\n`); return 127; }
      if (name.includes('/')) { // run a file
        const p = joinPath(s.cwd, name); const node = s.fs.get(p);
        if (!node) { ctx.err(`bash: ${name}: No such file or directory\n`); return 127; }
        if (node.t === 'd') { ctx.err(`bash: ${name}: Is a directory\n`); return 126; }
        if (!node.x) { ctx.err(`bash: ${name}: Permission denied\n`); return 126; }
        if (node.prog && PROGRAMS[node.prog]) return PROGRAMS[node.prog](ctx, args, node);
        if (node.kind === 'sh' || node.data.startsWith('#!')) return this.runScript(ctx, node.data, args);
        if (node.kind === 'py') return COMMANDS.python3(ctx, [name].concat(args));
        ctx.err(`bash: ${name}: cannot execute binary file: Exec format error\n`); return 126;
      }
      if (COMMANDS[name]) return COMMANDS[name](ctx, args);
      ctx.err(`bash: ${name}: command not found\n`); return 127;
    }

    async runScript(ctx, text, args) {
      const s = ctx.session; let code = 0;
      for (const raw of text.split('\n')) {
        const line = raw.trim(); if (!line || line.startsWith('#')) continue;
        if (/^(set|exec|trap|source|\.)\b/.test(line)) continue;
        code = await this.runLine(s, line);
      }
      return code;
    }

    get builtins() { return BUILTINS; }
  }

  /* ---------------- builtins (survive the restricted shell) ---------------- */
  const BUILTINS = {
    async echo(ctx, args) { let nl = true, esc = false; while (args.length && /^-[neE]+$/.test(args[0])) { if (args[0].includes('n')) nl = false; if (args[0].includes('e')) esc = true; args.shift(); } let t = args.join(' '); if (esc) t = t.replace(/\\n/g, '\n').replace(/\\t/g, '\t'); ctx.out(t + (nl ? '\n' : '')); return 0; },
    async cd(ctx, args) { const s = ctx.session; let t = args[0] || s.home; if (t === '-') t = s.env.OLDPWD || s.cwd; const p = joinPath(s.cwd, t.replace(/^~/, s.home)); const n = s.fs.get(p); if (!n) { ctx.err(`bash: cd: ${args[0]}: No such file or directory\n`); return 1; } if (n.t !== 'd') { ctx.err(`bash: cd: ${args[0]}: Not a directory\n`); return 1; } s.env.OLDPWD = s.cwd; s.cwd = p || '/'; s.env.PWD = s.cwd; return 0; },
    async pwd(ctx) { ctx.out(ctx.session.cwd + '\n'); return 0; },
    async exit(ctx) { if (ctx.session.noExit) { ctx.err('bash: exit: command not found\n'); return 127; } throw new ExitShell(0); },
    async logout(ctx) { throw new ExitShell(0); },
    async true() { return 0; }, async false() { return 1; }, async ':'() { return 0; },
    async export(ctx, args) { for (const a of args) { const i = a.indexOf('='); if (i > 0) ctx.session.env[a.slice(0, i)] = a.slice(i + 1); } return 0; },
    async unset(ctx, args) { for (const a of args) delete ctx.session.env[a]; return 0; },
    async history(ctx) { ctx.session.history.forEach((h, i) => ctx.out(`  ${String(i + 1).padStart(3)}  ${h}\n`)); return 0; },
    async type(ctx, args) { for (const a of args) { if (BUILTINS[a]) ctx.out(`${a} is a shell builtin\n`); else if (!ctx.session.restricted && COMMANDS[a]) ctx.out(`${a} is /usr/bin/${a}\n`); else { ctx.err(`bash: type: ${a}: not found\n`); return 1; } } return 0; },
    async help(ctx) { ctx.out('GNU bash, version 5.2.15(1)-release\nShell builtins: cd pwd echo exit export history type help\n'); if (!ctx.session.restricted) ctx.out('Programs on this machine: ' + Object.keys(COMMANDS).sort().join(' ') + '\n(try: man <command>)\n'); return 0; },
    async printf(ctx, args) { if (!args.length) return 1; let f = args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t'); let i = 1; f = f.replace(/%[sd]/g, () => args[i++] || ''); ctx.out(f); return 0; },
    async read(ctx, args) { const line = await ctx.readLine({ prompt: '' }); if (line == null) return 1; if (args[0]) ctx.session.env[args[args.length - 1]] = line; return 0; },
    async clear(ctx) { if (ctx.io.clear) ctx.io.clear(); return 0; },
    async alias() { return 0; },
    async set() { return 0; },
    async source(ctx) { return 0; },
  };

  /* ---------------- programs (commands) ---------------- */
  function fileArg(ctx, name) { const p = joinPath(ctx.session.cwd, name.replace(/^~/, ctx.session.home)); return { path: p, node: ctx.session.fs.get(p) }; }
  function readInputs(ctx, args, cmd) {
    // returns [{name, data, node}] for file args, or stdin
    if (!args.length) return ctx.hasStdin ? [{ name: '(standard input)', data: ctx.stdin || '', node: null }] : null;
    const out = [];
    for (const a of args) {
      if (a === '-') { out.push({ name: '(standard input)', data: ctx.stdin || '' }); continue; }
      const { node } = fileArg(ctx, a);
      if (!node) { ctx.err(`${cmd}: ${a}: No such file or directory\n`); out.push(null); continue; }
      if (node.t === 'd') { ctx.err(`${cmd}: ${a}: Is a directory\n`); out.push(null); continue; }
      out.push({ name: a, data: node.data, node });
    }
    return out;
  }
  function flags(args, spec) {
    // spec: {r:'recursive', ...}; returns {opts:{}, rest:[]}; combined short flags; long flags passthrough
    const opts = {}; const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { rest.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) { const k = a.slice(2).split('=')[0]; opts[k] = a.includes('=') ? a.split('=')[1] : true; continue; }
      if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) { const f = a[j]; if (spec && spec.values && spec.values.includes(f)) { opts[f] = a.slice(j + 1) || args[++i]; break; } opts[f] = true; }
        continue;
      }
      rest.push(a);
    }
    return { opts, rest };
  }
  function fmtSize(n) { return String(n); }
  function lsLine(name, node) { const perm = node.t === 'd' ? 'drwxr-xr-x' : (node.x ? '-rwxr-xr-x' : '-rw-r--r--'); const size = node.t === 'd' ? 4096 : node.data.length; return `${perm} 1 ctf ctf ${String(size).padStart(7)} Oct 16 15:45 ${name}`; }
  function makeRegex(pat, opts) {
    const fl = opts.i ? 'i' : '';
    if (opts.F) return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), fl);
    let p = pat;
    if (!opts.E) p = p.replace(/\\([(){}|+?])/g, '$1').replace(/(^|[^\\])([(){}|+?])/g, (m, a, b) => a + (b === '{' || b === '}' ? '\\' + b : '\\' + b));
    try { return new RegExp(p, fl); } catch (e) { return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), fl); }
  }

  const COMMANDS = {
    async ls(ctx, args) {
      const { opts, rest } = flags(args); const s = ctx.session; const targets = rest.length ? rest : ['.']; let code = 0;
      const multi = targets.length > 1;
      const list = (p, node, label) => {
        if (node.t === 'f') { ctx.out((opts.l ? lsLine(label, node) : label) + '\n'); return; }
        let names = Object.keys(node.c).sort((a, b) => a.localeCompare(b));
        if (opts.a || opts.A) { if (opts.a) names = ['.', '..'].concat(names); } else names = names.filter(n => !n.startsWith('.'));
        if (opts.l) {
          ctx.out(`total ${names.length}\n`);
          for (const n of names) ctx.out(lsLine(n, n === '.' ? node : n === '..' ? (s.fs.get(dirName(p)) || node) : node.c[n]) + '\n');
        } else if (names.length) ctx.out(names.map(n => n + (node.c[n] && node.c[n].t === 'd' ? '/' : '')).join('  ') + '\n');
        if (opts.R) for (const n of names) if (node.c[n] && node.c[n].t === 'd' && n !== '.' && n !== '..') { const sub = joinPath(p, n); ctx.out(`\n${label === '.' ? './' + n : (label.endsWith('/') ? label + n : label + '/' + n)}:\n`); list(sub, node.c[n], label === '.' ? './' + n : label + '/' + n); }
      };
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]; const { path, node } = fileArg(ctx, t);
        if (!node) { ctx.err(`ls: cannot access '${t}': No such file or directory\n`); code = 2; continue; }
        if (multi && node.t === 'd') ctx.out((i ? '\n' : '') + t + ':\n');
        list(path, node, t);
      }
      return code;
    },
    async cat(ctx, args) { const ins = readInputs(ctx, args, 'cat'); if (!ins) return 0; let code = 0; for (const f of ins) { if (!f) { code = 1; continue; } ctx.out(f.node && f.node.bin ? f.data.split('').map(c => { const k = c.charCodeAt(0); return isPrintable(k) || k === 10 ? c : (k === 0 ? '' : String.fromCharCode(0xFFFD)); }).join('') + (f.data.endsWith('\n') ? '' : '\n') : f.data); } return code; },
    async tac(ctx, args) { const ins = readInputs(ctx, args, 'tac'); if (!ins) return 0; for (const f of ins) if (f) ctx.out(f.data.replace(/\n$/, '').split('\n').reverse().join('\n') + '\n'); return 0; },
    async less(ctx, args) { return COMMANDS.cat(ctx, args); }, async more(ctx, args) { return COMMANDS.cat(ctx, args); },
    async head(ctx, args) { const { opts, rest } = flags(args, { values: ['n', 'c'] }); const n = parseInt(opts.n || 10, 10); const ins = readInputs(ctx, rest, 'head'); if (!ins) return 0; for (const f of ins) if (f) { if (opts.c) ctx.out(f.data.slice(0, parseInt(opts.c, 10))); else ctx.out(f.data.split('\n').slice(0, n).join('\n') + '\n'); } return 0; },
    async tail(ctx, args) { const { opts, rest } = flags(args, { values: ['n', 'c'] }); const n = parseInt(opts.n || 10, 10); const ins = readInputs(ctx, rest, 'tail'); if (!ins) return 0; for (const f of ins) if (f) { const lines = f.data.replace(/\n$/, '').split('\n'); ctx.out(lines.slice(-n).join('\n') + '\n'); } return 0; },
    async wc(ctx, args) { const { opts, rest } = flags(args); const ins = readInputs(ctx, rest, 'wc'); if (!ins) return 0; for (const f of ins) if (f) { const l = (f.data.match(/\n/g) || []).length, w = f.data.split(/\s+/).filter(Boolean).length, c = f.data.length; const parts = []; if (opts.l) parts.push(l); if (opts.w) parts.push(w); if (opts.c) parts.push(c); if (!parts.length) parts.push(l, w, c); ctx.out(parts.map(x => String(x).padStart(7)).join('') + (f.name === '(standard input)' ? '' : ' ' + f.name) + '\n'); } return 0; },
    async sort(ctx, args) { const { opts, rest } = flags(args); const ins = readInputs(ctx, rest, 'sort'); if (!ins) return 0; let lines = []; for (const f of ins) if (f) lines.push(...f.data.replace(/\n$/, '').split('\n')); lines.sort(opts.n ? (a, b) => parseFloat(a) - parseFloat(b) : undefined); if (opts.r) lines.reverse(); if (opts.u) lines = lines.filter((x, i) => i === 0 || x !== lines[i - 1]); ctx.out(lines.join('\n') + '\n'); return 0; },
    async uniq(ctx, args) { const { opts, rest } = flags(args); const ins = readInputs(ctx, rest, 'uniq'); if (!ins) return 0; for (const f of ins) if (f) { const lines = f.data.replace(/\n$/, '').split('\n'); const out = []; let prev = null, cnt = 0; const flush = () => { if (prev !== null) out.push(opts.c ? `${String(cnt).padStart(7)} ${prev}` : prev); }; for (const l of lines) { if (l === prev) cnt++; else { flush(); prev = l; cnt = 1; } } flush(); ctx.out(out.join('\n') + '\n'); } return 0; },
    async rev(ctx, args) { const ins = readInputs(ctx, args, 'rev'); if (!ins) return 0; for (const f of ins) if (f) ctx.out(f.data.replace(/\n$/, '').split('\n').map(l => l.split('').reverse().join('')).join('\n') + '\n'); return 0; },
    async tr(ctx, args) { if (args.length < 2 && !args.includes('-d')) { ctx.err('usage: tr SET1 SET2\n'); return 1; } const expand = set => set.replace(/(\w)-(\w)/g, (m, a, b) => { let o = ''; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) o += String.fromCharCode(c); return o; }); const del = args[0] === '-d'; const s1 = expand(args[del ? 1 : 0]), s2 = del ? '' : expand(args[1]); let out = ''; for (const ch of ctx.stdin || '') { const i = s1.indexOf(ch); if (i < 0) out += ch; else if (!del) out += s2[Math.min(i, s2.length - 1)]; } ctx.out(out); return 0; },
    async grep(ctx, args) {
      const { opts, rest } = flags(args, { values: ['e', 'A', 'B', 'C', 'm'] });
      const pat = opts.e || rest.shift(); if (pat == null) { ctx.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n'); return 2; }
      const re = makeRegex(pat, opts); const reG = new RegExp(re.source, re.flags + 'g');
      let files = []; let code = 1;
      const s = ctx.session;
      if (opts.r || opts.R) {
        const roots = rest.length ? rest : ['.'];
        for (const r of roots) { const { path, node } = fileArg(ctx, r); if (!node) { ctx.err(`grep: ${r}: No such file or directory\n`); code = 2; continue; } s.fs.walk(path, (p, n) => { if (n.t === 'f') { const rel = r === '.' ? p.slice(s.cwd.length + 1) || p : (p === path ? r : (r.endsWith('/') ? r : r + '/') + p.slice(path.length + 1)); files.push({ name: rel, data: n.data, node: n }); } }); }
      } else {
        if (!rest.length) files = [{ name: '(standard input)', data: ctx.stdin || '' }];
        else for (const a of rest) { const { node } = fileArg(ctx, a); if (!node) { ctx.err(`grep: ${a}: No such file or directory\n`); code = 2; continue; } if (node.t === 'd') { ctx.err(`grep: ${a}: Is a directory\n`); continue; } files.push({ name: a, data: node.data, node }); }
      }
      const showName = opts.h ? false : (opts.H || files.length > 1 || opts.r || opts.R);
      for (const f of files) {
        const lines = f.data.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]; const hit = re.test(line);
          if (hit !== !!opts.v) {
            count++; code = code === 2 ? 2 : 0;
            if (opts.c || opts.l) continue;
            const prefix = (showName ? f.name + ':' : '') + (opts.n ? (i + 1) + ':' : '');
            if (opts.o) { const ms = line.match(reG) || []; for (const m of ms) if (m) ctx.out(prefix + m + '\n'); }
            else ctx.out(prefix + (f.node && f.node.bin ? line.replace(/[^\x20-\x7e\t]/g, '') : line) + '\n');
          }
        }
        if (opts.c) ctx.out((showName ? f.name + ':' : '') + count + '\n');
        if (opts.l && count) ctx.out(f.name + '\n');
      }
      return code;
    },
    async egrep(ctx, args) { return COMMANDS.grep(ctx, ['-E'].concat(args)); },
    async strings(ctx, args) { const { opts, rest } = flags(args, { values: ['n'] }); const min = parseInt(opts.n || 4, 10); const ins = readInputs(ctx, rest, 'strings'); if (!ins) return 0; for (const f of ins) if (f) { let run = ''; const flush = () => { if (run.length >= min) ctx.out(run + '\n'); run = ''; }; for (const ch of f.data) { if (isPrintable(ch.charCodeAt(0))) run += ch; else flush(); } flush(); } return 0; },
    async file(ctx, args) {
      if (!args.length) { ctx.err('Usage: file FILE...\n'); return 1; }
      for (const a of args) {
        const { node } = fileArg(ctx, a);
        if (!node) { ctx.out(`${a}: cannot open \`${a}' (No such file or directory)\n`); continue; }
        let d;
        if (node.t === 'd') d = 'directory';
        else if (node.kind === 'elf') d = 'ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, not stripped';
        else if (node.kind === 'zip') d = 'Zip archive data, at least v2.0 to extract, compression method=deflate';
        else if (node.kind === 'png') d = `PNG image data, ${node.w || 1200} x ${node.h || 600}, 8-bit/color RGBA, non-interlaced`;
        else if (node.kind === 'jpg') d = `JPEG image data, JFIF standard 1.01, resolution (DPI), density 72x72, segment length 16, baseline, precision 8, ${node.w || 1024}x${node.h || 768}, components 3`;
        else if (node.kind === 'py' || node.data.startsWith('#!/usr/bin/env python') || node.data.startsWith('#!/usr/bin/python')) d = 'Python script, ASCII text executable';
        else if (node.kind === 'sh' || node.data.startsWith('#!/bin/bash') || node.data.startsWith('#!/bin/sh')) d = 'Bourne-Again shell script, ASCII text executable';
        else if (node.bin) d = 'data';
        else if (!node.data.length) d = 'empty';
        else if (/^[A-Za-z0-9+/=\s]+$/.test(node.data)) d = 'ASCII text';
        else d = /[^\x00-\x7f]/.test(node.data) ? 'UTF-8 Unicode text' : 'ASCII text';
        ctx.out(`${a}: ${d}\n`);
      }
      return 0;
    },
    async find(ctx, args) {
      const s = ctx.session; const roots = []; let i = 0;
      while (i < args.length && !args[i].startsWith('-')) roots.push(args[i++]);
      if (!roots.length) roots.push('.');
      let name = null, iname = false, type = null;
      for (; i < args.length; i++) { if (args[i] === '-name') name = args[++i]; else if (args[i] === '-iname') { name = args[++i]; iname = true; } else if (args[i] === '-type') type = args[++i]; }
      const re = name ? new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', iname ? 'i' : '') : null;
      let code = 0;
      for (const r of roots) {
        const { path, node } = fileArg(ctx, r);
        if (!node) { ctx.err(`find: '${r}': No such file or directory\n`); code = 1; continue; }
        s.fs.walk(path, (p, n) => {
          const rel = p === path ? r : (r.endsWith('/') ? r : r + '/') + p.slice(path.length + 1);
          if (type === 'f' && n.t !== 'f') return; if (type === 'd' && n.t !== 'd') return;
          if (re && !re.test(baseName(p))) return;
          ctx.out(rel + '\n');
        });
      }
      return code;
    },
    async tree(ctx, args) { const s = ctx.session; const { opts, rest } = flags(args); const { path, node } = fileArg(ctx, rest[0] || '.'); if (!node) { ctx.err(`tree: ${rest[0]}: No such file or directory\n`); return 1; } ctx.out((rest[0] || '.') + '\n'); let nd = 0, nf = 0; const rec = (n, pre) => { const names = Object.keys(n.c).filter(k => opts.a || !k.startsWith('.')).sort(); names.forEach((k, i) => { const last = i === names.length - 1; const ch = n.c[k]; ctx.out(pre + (last ? '└── ' : '├── ') + k + '\n'); if (ch.t === 'd') { nd++; rec(ch, pre + (last ? '    ' : '│   ')); } else nf++; }); }; if (node.t === 'd') rec(node, ''); ctx.out(`\n${nd} directories, ${nf} files\n`); return 0; },
    async mkdir(ctx, args) { const { opts, rest } = flags(args); let code = 0; for (const a of rest) { const p = joinPath(ctx.session.cwd, a); if (ctx.session.fs.get(p)) { ctx.err(`mkdir: cannot create directory '${a}': File exists\n`); code = 1; continue; } if (opts.p) ctx.session.fs.mkdirp(p); else { const d = ctx.session.fs.get(dirName(p)); if (!d) { ctx.err(`mkdir: cannot create directory '${a}': No such file or directory\n`); code = 1; continue; } d.c[baseName(p)] = dir(); } } return code; },
    async touch(ctx, args) { for (const a of args) { const p = joinPath(ctx.session.cwd, a); if (!ctx.session.fs.get(p)) ctx.session.fs.write(p, ''); } return 0; },
    async rm(ctx, args) { const { opts, rest } = flags(args); let code = 0; for (const a of rest) { const { path, node } = fileArg(ctx, a); if (!node) { ctx.err(`rm: cannot remove '${a}': No such file or directory\n`); code = 1; continue; } if (node.t === 'd' && !opts.r && !opts.R) { ctx.err(`rm: cannot remove '${a}': Is a directory\n`); code = 1; continue; } if (path === ctx.session.home || path === '/') { ctx.err(`rm: refusing to remove '${a}'\n`); code = 1; continue; } ctx.session.fs.remove(path); } return code; },
    async rmdir(ctx, args) { for (const a of args) { const { path, node } = fileArg(ctx, a); if (!node || node.t !== 'd') { ctx.err(`rmdir: failed to remove '${a}': No such file or directory\n`); return 1; } if (Object.keys(node.c).length) { ctx.err(`rmdir: failed to remove '${a}': Directory not empty\n`); return 1; } ctx.session.fs.remove(path); } return 0; },
    async cp(ctx, args) { const { opts, rest } = flags(args); if (rest.length < 2) { ctx.err('cp: missing file operand\n'); return 1; } const dst = rest.pop(); const { path: dp, node: dn } = fileArg(ctx, dst); for (const a of rest) { const { node } = fileArg(ctx, a); if (!node) { ctx.err(`cp: cannot stat '${a}': No such file or directory\n`); return 1; } if (node.t === 'd' && !opts.r && !opts.R) { ctx.err(`cp: -r not specified; omitting directory '${a}'\n`); return 1; } const target = dn && dn.t === 'd' ? joinPath(dp, baseName(a)) : dp; const copy = JSON.parse(JSON.stringify(node)); copy.dirty = true; const parent = ctx.session.fs.get(dirName(target)); if (!parent) { ctx.err(`cp: cannot create '${dst}': No such file or directory\n`); return 1; } parent.c[baseName(target)] = copy; } return 0; },
    async mv(ctx, args) { const { rest } = flags(args); if (rest.length < 2) { ctx.err('mv: missing file operand\n'); return 1; } const dst = rest.pop(); const { path: dp, node: dn } = fileArg(ctx, dst); for (const a of rest) { const { path, node } = fileArg(ctx, a); if (!node) { ctx.err(`mv: cannot stat '${a}': No such file or directory\n`); return 1; } const target = dn && dn.t === 'd' ? joinPath(dp, baseName(a)) : dp; const parent = ctx.session.fs.get(dirName(target)); if (!parent) { ctx.err(`mv: cannot move '${a}' to '${dst}': No such file or directory\n`); return 1; } ctx.session.fs.remove(path); node.dirty = true; parent.c[baseName(target)] = node; } return 0; },
    async chmod(ctx, args) { const { rest } = flags(args); const mode = rest.shift(); if (!mode || !rest.length) { ctx.err('chmod: missing operand\n'); return 1; } for (const a of rest) { const { node } = fileArg(ctx, a); if (!node) { ctx.err(`chmod: cannot access '${a}': No such file or directory\n`); return 1; } if (/\+x/.test(mode) || /^[0-7]*[1357]/.test(mode) || mode === '755' || mode === '777' || mode === '700') node.x = true; if (/-x/.test(mode) || mode === '644' || mode === '600') node.x = false; node.dirty = true; } return 0; },
    async chown() { return 0; },
    async base64(ctx, args) {
      const { opts, rest } = flags(args, { values: ['w'] }); const ins = readInputs(ctx, rest, 'base64'); if (!ins) return 0; let code = 0;
      for (const f of ins) { if (!f) { code = 1; continue; }
        if (opts.d) { const clean = f.data.replace(/\s+/g, ''); if (/[^A-Za-z0-9+/=]/.test(clean) || clean.length % 4 === 1) { ctx.err('base64: invalid input\n'); code = 1; } let b; try { b = b64decode(clean); } catch (e) { ctx.err('base64: invalid input\n'); code = 1; continue; } ctx.out(b.split('').some(c => c.charCodeAt(0) > 127) ? bytesToUtf8(b) : b); }
        else { const raw = f.node && f.node.bin ? f.data : utf8ToBytes(f.data); const enc = b64encode(raw); const w = opts.w != null ? parseInt(opts.w, 10) : 76; if (w === 0) ctx.out(enc + '\n'); else ctx.out((enc.match(new RegExp('.{1,' + w + '}', 'g')) || ['']).join('\n') + '\n'); } }
      return code;
    },
    async xxd(ctx, args) { const ins = readInputs(ctx, args, 'xxd'); if (!ins) return 0; for (const f of ins) if (f) { for (let i = 0; i < Math.min(f.data.length, 4096); i += 16) { const chunk = f.data.slice(i, i + 16); const hex = chunk.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').match(/.{1,4}/g).join(' '); const asc = chunk.split('').map(c => isPrintable(c.charCodeAt(0)) ? c : '.').join(''); ctx.out(`${i.toString(16).padStart(8, '0')}: ${hex.padEnd(39)}  ${asc}\n`); } if (f.data.length > 4096) ctx.out('... (truncated)\n'); } return 0; },
    async hexdump(ctx, args) { return COMMANDS.xxd(ctx, args.filter(a => a !== '-C')); },
    async md5sum(ctx, args) { const ins = readInputs(ctx, args, 'md5sum'); if (!ins) return 0; for (const f of ins) if (f) ctx.out(hashStr(f.data).toString(16).padStart(8, '0').repeat(4) + '  ' + f.name + '\n'); return 0; },
    async sha256sum(ctx, args) { const ins = readInputs(ctx, args, 'sha256sum'); if (!ins) return 0; for (const f of ins) if (f) { let h = ''; for (let k = 0; k < 8; k++) h += hashStr(f.data + k).toString(16).padStart(8, '0'); ctx.out(h + '  ' + f.name + '\n'); } return 0; },
    async unzip(ctx, args) {
      const { opts, rest } = flags(args, { values: ['d'] }); if (!rest.length) { ctx.err('UnZip 6.00\nUsage: unzip [-l] file[.zip] [-d exdir]\n'); return 10; }
      const s = ctx.session; const { node } = fileArg(ctx, rest[0]);
      if (!node) { ctx.err(`unzip:  cannot find or open ${rest[0]}, ${rest[0]}.zip or ${rest[0]}.ZIP.\n`); return 9; }
      if (!node.zip) { ctx.err(`Archive:  ${rest[0]}\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.\nunzip:  cannot find zipfile directory in one of ${rest[0]} or\n        ${rest[0]}.zip, and cannot find ${rest[0]}.ZIP, period.\n`); return 9; }
      ctx.out(`Archive:  ${rest[0]}\n`);
      if (node.kind !== 'zip') ctx.out(`warning [${rest[0]}]:  ${node.zipOffset || 4096} extra bytes at beginning or within zipfile\n  (attempting to process anyway)\n`);
      const dest = opts.d ? joinPath(s.cwd, opts.d) : s.cwd; s.fs.mkdirp(dest);
      let count = 0;
      const rec = (n, p) => { for (const k of Object.keys(n.c).sort()) { const ch = n.c[k]; const rel = p ? p + '/' + k : k; const target = joinPath(dest, rel);
        if (ch.t === 'd') { if (opts.l) ctx.out(`        0  10-16-2026 15:45   ${rel}/\n`); else { const existed = !!s.fs.get(target); s.fs.mkdirp(target); if (!existed) ctx.out(`   creating: ${rel}/\n`); } rec(ch, rel); }
        else { count++; if (opts.l) ctx.out(`${String(ch.data.length).padStart(9)}  10-16-2026 15:45   ${rel}\n`); else { const copy = JSON.parse(JSON.stringify(ch)); copy.dirty = true; const parent = s.fs.get(dirName(target)); if (parent) parent.c[baseName(target)] = copy; ctx.out(` ${ch.bin ? 'extracting' : ' inflating'}: ${rel}\n`); } } } };
      if (opts.l) ctx.out('  Length      Date    Time    Name\n---------  ---------- -----   ----\n');
      rec(node.zip, '');
      if (opts.l) ctx.out(`---------                     -------\n                              ${count} files\n`);
      return 0;
    },
    async zip(ctx) { ctx.err('zip: creating archives is not available on this machine\n'); return 1; },
    async wget(ctx, args) {
      const { opts, rest } = flags(args, { values: ['O'] }); const url = rest[0]; if (!url) { ctx.err('wget: missing URL\nUsage: wget [OPTION]... [URL]...\n'); return 1; }
      const s = ctx.session; const dl = (s.challenge && s.challenge.downloads) || {};
      const key = Object.keys(dl).find(k => dl[k].url === url || url.endsWith('/' + k) || url === k);
      const stamp = '--2026-10-16 15:45:12--  ';
      if (!key) { ctx.out(`${stamp}${url}\nResolving ${url.replace(/^https?:\/\//, '').split('/')[0]}... failed: Name or service not known.\nwget: unable to resolve host address\n`); return 4; }
      const spec = dl[key]; const name = opts.O || key; const node = makeFile(spec.file, (s.challenge.slug || 'dl') + '/' + key);
      const host = (spec.url || url).replace(/^https?:\/\//, '').split('/')[0];
      ctx.out(`${stamp}${spec.url || url}\nResolving ${host}... 172.67.164.9\nConnecting to ${host}|172.67.164.9|:443... connected.\nHTTP request sent, awaiting response... 200 OK\nLength: ${node.data.length} (${node.data.length > 1024 ? (node.data.length / 1024).toFixed(1) + 'K' : node.data.length}) [${node.bin ? 'application/octet-stream' : 'text/plain'}]\nSaving to: '${name}'\n\n${name.padEnd(24).slice(0, 24)} 100%[===================>] ${String(node.data.length).padStart(7)}  --.-KB/s    in 0.01s\n\n2026-10-16 15:45:12 (${(2 + Math.random() * 9).toFixed(1)} MB/s) - '${name}' saved [${node.data.length}/${node.data.length}]\n\n`);
      const target = joinPath(s.cwd, name); const parent = s.fs.get(dirName(target)); if (!parent || parent.t !== 'd') { ctx.err(`${name}: No such file or directory\n`); return 3; }
      node.dirty = true; parent.c[baseName(target)] = node;
      return 0;
    },
    async curl(ctx, args) {
      const { opts, rest } = flags(args, { values: ['H', 'b', 'o', 'X', 'd', 'A'] }); const url = rest[0]; if (!url) { ctx.err("curl: try 'curl --help' for more information\n"); return 2; }
      if (typeof fetch !== 'function') { ctx.err('curl: (6) Could not resolve host\n'); return 6; }
      let u; try { u = new URL(url, (typeof location !== 'undefined' ? location.href : 'https://flippedbyneel.com/')); } catch (e) { ctx.err(`curl: (3) URL using bad/illegal format\n`); return 3; }
      if (typeof location !== 'undefined' && u.origin !== location.origin) { ctx.err(`curl: (7) Failed to connect to ${u.hostname} port 443: this practice machine can only reach ${location.hostname}\n`); return 7; }
      try {
        const res = await fetch(u.href, { method: opts.I ? 'HEAD' : (opts.X || 'GET'), cache: 'no-store', headers: opts.A ? { 'X-Requested-User-Agent': opts.A } : {} });
        if (opts.I || opts.i || opts.v) { ctx.out(`HTTP/1.1 ${res.status} ${res.statusText || ''}\n`); res.headers.forEach((v, k) => ctx.out(`${k}: ${v}\n`)); ctx.out('\n'); }
        if (!opts.I) { const t = await res.text(); if (opts.o) ctx.session.fs.write(joinPath(ctx.session.cwd, opts.o), t); else ctx.out(t + (t.endsWith('\n') ? '' : '\n')); }
        return 0;
      } catch (e) { ctx.err(`curl: (7) Failed to connect to ${u.hostname}\n`); return 7; }
    },
    async nc(ctx, args) {
      const { opts, rest } = flags(args, { values: ['p', 'w'] }); const host = rest[0], port = rest[1];
      if (!host || !port) { ctx.err('usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]\n'); return 1; }
      const s = ctx.session; const svc = ((s.challenge && s.challenge.services) || []).find(x => x.kind === 'nc' && x.host === host && String(x.port) === String(port));
      if (!svc) { ctx.err(`nc: connect to ${host} port ${port} (tcp) failed: Connection refused\n`); return 1; }
      const h = SERVICES[svc.handler]; if (!h) { ctx.err('nc: service misconfigured\n'); return 1; }
      return h(ctx, svc, args);
    },
    async netcat(ctx, args) { return COMMANDS.nc(ctx, args); },
    async ssh(ctx, args) {
      const { opts, rest } = flags(args, { values: ['p', 'i', 'l'] }); const target = rest[0];
      if (!target) { ctx.err('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-Q query_option]\n           [-R address] [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n           destination [command [argument ...]]\n'); return 255; }
      const at = target.indexOf('@'); const user = opts.l || (at >= 0 ? target.slice(0, at) : ctx.session.user); const host = at >= 0 ? target.slice(at + 1) : target; const port = opts.p || '22';
      const s = ctx.session; const svc = ((s.challenge && s.challenge.services) || []).find(x => x.kind === 'ssh' && x.host === host);
      if (!svc) { ctx.err(`ssh: Could not resolve hostname ${host}: Name or service not known\n`); return 255; }
      if (String(svc.port) !== String(port)) { ctx.err(`ssh: connect to host ${host} port ${port}: Connection refused\n`); return 255; }
      if (user !== svc.user) { ctx.err(`${user}@${host}: Permission denied (publickey,password).\n`); return 255; }
      if (!s.knownHosts) s.knownHosts = {};
      if (!s.knownHosts[host + ':' + port]) {
        ctx.out(`The authenticity of host '[${host}]:${port} ([172.67.164.9]:${port})' can't be established.\nED25519 key fingerprint is SHA256:${b64encode(fakeBytes(host + port, 32)).replace(/=+$/, '')}.\nThis key is not known by any other names.\n`);
        for (;;) { const a = await ctx.readLine({ prompt: 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ' }); if (a == null) return 255; if (a.trim() === 'yes') break; if (a.trim() === 'no') { ctx.err('Host key verification failed.\n'); return 255; } ctx.out("Please type 'yes', 'no' or the fingerprint: "); }
        s.knownHosts[host + ':' + port] = true;
        ctx.out(`Warning: Permanently added '[${host}]:${port}' (ED25519) to the list of known hosts.\n`);
      }
      for (let tries = 0; tries < 3; tries++) {
        const pw = await ctx.readLine({ prompt: `${user}@${host}'s password: `, hidden: true }); if (pw == null) return 255;
        if (pw === svc.password) break;
        if (tries === 2) { ctx.err(`${user}@${host}: Permission denied (publickey,password).\n`); return 255; }
        ctx.out('Permission denied, please try again.\n');
      }
      const h = SERVICES[svc.handler]; if (!h) { ctx.err('ssh: service misconfigured\n'); return 255; }
      const code = await h(ctx, svc, args);
      ctx.out(`Connection to ${host} closed.\n`);
      return code;
    },
    async python3(ctx, args) {
      const py = ctx.shell.pyBridge; if (!py) { ctx.err('python3: not available on this machine\n'); return 127; }
      return py.run(ctx, args);
    },
    async python(ctx, args) { return COMMANDS.python3(ctx, args); },
    async nano(ctx, args) {
      const name = args.filter(a => !a.startsWith('-'))[0]; if (!name) { ctx.err('nano: a file name is required on this machine (nano FILE)\n'); return 1; }
      if (!ctx.io.edit) { ctx.err('nano: no editor available in a pipe\n'); return 1; }
      const s = ctx.session; const p = joinPath(s.cwd, name.replace(/^~/, s.home)); const node = s.fs.get(p);
      if (node && node.t === 'd') { ctx.err(`[ Error: ${name} is a directory ]\n`); return 1; }
      const text = node ? node.data : '';
      const result = await ctx.io.edit(name, text, { isNew: !node });
      if (result && result.saved) { s.fs.write(p, result.content, node ? {} : { kind: /\.py$/.test(name) ? 'py' : /\.sh$/.test(name) ? 'sh' : 'text' }); }
      return 0;
    },
    async vi(ctx, args) { ctx.err('vi: this machine only has nano. Try: nano ' + (args[0] || 'FILE') + '\n'); return 1; },
    async vim(ctx, args) { return COMMANDS.vi(ctx, args); },
    async man(ctx, args) { const t = args[0]; if (!t) { ctx.err('What manual page do you want?\nFor example, try \'man ls\'.\n'); return 1; } const m = MAN[t]; if (!m) { ctx.err(`No manual entry for ${t}\n`); return 16; } ctx.out(m.trim() + '\n'); return 0; },
    async which(ctx, args) { let code = 0; for (const a of args) { if (COMMANDS[a]) ctx.out(`/usr/bin/${a}\n`); else if (BUILTINS[a]) ctx.out(`${a}: shell built-in command\n`); else code = 1; } return code; },
    async whoami(ctx) { ctx.out(ctx.session.user + '\n'); return 0; },
    async id(ctx) { ctx.out(`uid=1000(${ctx.session.user}) gid=1000(${ctx.session.user}) groups=1000(${ctx.session.user})\n`); return 0; },
    async hostname(ctx) { ctx.out(ctx.session.host + '\n'); return 0; },
    async uname(ctx, args) { ctx.out(args.includes('-a') ? 'Linux practice 6.1.0-18-amd64 #1 SMP Debian x86_64 GNU/Linux\n' : 'Linux\n'); return 0; },
    async date(ctx) { ctx.out(new Date().toString().replace(/ GMT.*$/, '') + '\n'); return 0; },
    async env(ctx) { for (const k of Object.keys(ctx.session.env)) ctx.out(`${k}=${ctx.session.env[k]}\n`); return 0; },
    async seq(ctx, args) { const n = args.map(Number); let a = 1, b = n[0], st = 1; if (n.length === 2) { a = n[0]; b = n[1]; } if (n.length === 3) { a = n[0]; st = n[1]; b = n[2]; } const out = []; for (let i = a; st > 0 ? i <= b : i >= b; i += st) out.push(i); ctx.out(out.join('\n') + '\n'); return 0; },
    async sleep() { return 0; },
    async yes(ctx, args) { const t = args[0] || 'y'; for (let i = 0; i < 200; i++) ctx.out(t + '\n'); if (!ctx.isPipe) { await ctx.readLine({ prompt: '', spin: true }); } return 0; },
    async cut(ctx, args) { const { opts, rest } = flags(args, { values: ['d', 'f', 'c'] }); const ins = readInputs(ctx, rest, 'cut'); if (!ins) return 0; for (const f of ins) if (f) for (const line of f.data.replace(/\n$/, '').split('\n')) { if (opts.c) { const [a, b] = opts.c.split('-').map(Number); ctx.out(line.slice(a - 1, b || a) + '\n'); } else { const d = opts.d || '\t'; const parts = line.split(d); const idx = (opts.f || '1').split(',').map(Number); ctx.out(idx.map(i => parts[i - 1] || '').join(d) + '\n'); } } return 0; },
    async awk(ctx) { ctx.err('awk: not installed on this machine (try cut, grep or python3)\n'); return 127; },
    async sed(ctx) { ctx.err('sed: not installed on this machine (try grep, tr or python3)\n'); return 127; },
    async git(ctx) { ctx.err('git: not installed on this machine yet\n'); return 127; },
    async sudo(ctx, args) { ctx.err(`${ctx.session.user} is not in the sudoers file.  This incident will be reported.\n`); return 1; },
    async apt(ctx) { ctx.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\n'); return 100; },
    async pip(ctx) { ctx.err('pip: no network on this machine\n'); return 1; },
    async open(ctx) { ctx.err("open: this machine has no screen. For pictures: base64 -w0 FILE, copy the output, and use CyberChef 'From Base64' then 'Render Image'.\n"); return 1; },
    async xdg_open(ctx, a) { return COMMANDS.open(ctx, a); },
    async exiftool(ctx, args) { const { rest } = flags(args); for (const a of rest) { const { node } = fileArg(ctx, a); if (!node) { ctx.err(`File not found: ${a}\n`); return 1; } ctx.out(`ExifTool Version Number         : 12.40\nFile Name                       : ${a}\nFile Size                       : ${node.data.length} bytes\nFile Type                       : ${(node.kind || 'TXT').toUpperCase()}\n`); if (node.meta) for (const k of Object.keys(node.meta)) ctx.out(`${k.padEnd(32)}: ${node.meta[k]}\n`); } return 0; },
  };

  const MAN = {
    ls: 'LS(1)\nNAME\n    ls - list directory contents\nSYNOPSIS\n    ls [OPTION]... [FILE]...\nOPTIONS\n    -a   do not ignore entries starting with .\n    -l   use a long listing format (permissions, size)\n    -R   list subdirectories recursively',
    cd: 'CD\n    cd [DIR]   change the working directory. cd with no argument goes home. cd .. goes up one.',
    cat: 'CAT(1)\n    cat [FILE]...   print files to the screen, one after another.',
    grep: 'GREP(1)\nNAME\n    grep - print lines that match patterns\nSYNOPSIS\n    grep [OPTION]... PATTERNS [FILE]...\nOPTIONS\n    -i   ignore case\n    -r   search every file in a folder and its subfolders\n    -o   print only the matching part of the line\n    -n   print line numbers\n    -v   print lines that do NOT match\n    -c   count matching lines',
    strings: 'STRINGS(1)\n    strings [FILE]   print the sequences of printable characters in a file (default: 4 or more in a row).',
    base64: 'BASE64(1)\n    base64 [FILE]      encode\n    base64 -d [FILE]   decode\n    -w 0               do not wrap the output',
    unzip: 'UNZIP(1)\n    unzip FILE.zip        extract\n    unzip -l FILE.zip     list the contents without extracting\n    unzip FILE -d DIR     extract into DIR',
    file: 'FILE(1)\n    file FILE...   determine the file type by looking at its contents, not its name.',
    find: 'FIND(1)\n    find [START] -name PATTERN   search for files by name, in every folder below START (. means here)\n    find . -name "*.txt"         wildcards need quotes',
    wget: 'WGET(1)\n    wget URL       download a file into the current folder\n    wget -O NAME URL   save it under NAME',
    curl: 'CURL(1)\n    curl URL       fetch a page and print it\n    curl -I URL    headers only (a HEAD request)\n    curl -o FILE URL   save instead of print',
    nc: 'NC(1)\n    nc HOST PORT   open a connection to HOST on PORT and show what comes back. Ctrl+C hangs up.',
    ssh: 'SSH(1)\n    ssh USER@HOST -p PORT   log in to another computer. Passwords are typed blind (nothing shows). exit to leave.',
    nano: 'NANO(1)\n    nano FILE      edit a file. Ctrl+O then Enter saves. Ctrl+X leaves. Ctrl+K cuts a line, Ctrl+U pastes it back. Ctrl+F searches.\n    (Ctrl+W would close the browser tab, so this nano uses Ctrl+F for search.)',
    python3: 'PYTHON3(1)\n    python3 SCRIPT.py       run a script\n    python3 -c "CODE"       run one line of code\n    python3                 interactive mode (Ctrl+D to leave)',
    chmod: 'CHMOD(1)\n    chmod +x FILE   make a file runnable (then ./FILE runs it)',
    echo: 'ECHO(1)\n    echo TEXT      print TEXT. With a * in it, the shell first replaces the * with the file names here.',
    head: 'HEAD(1)\n    head [-n N] FILE   first N lines (default 10)', tail: 'TAIL(1)\n    tail [-n N] FILE   last N lines (default 10)',
    wc: 'WC(1)\n    wc [-l|-w|-c] FILE   count lines, words, characters',
    tree: 'TREE(1)\n    tree [DIR]   draw the folder structure',
    mkdir: 'MKDIR(1)\n    mkdir DIR   make a folder', rm: 'RM(1)\n    rm FILE      delete a file. There is no trash can.\n    rm -r DIR    delete a folder and everything in it',
    cp: 'CP(1)\n    cp SRC DST   copy', mv: 'MV(1)\n    mv SRC DST   move or rename',
    man: 'MAN(1)\n    man COMMAND   read the manual page for COMMAND',
    xxd: 'XXD(1)\n    xxd FILE   show the bytes of a file in hexadecimal',
    useless: 'USELESS(1)\nNAME\n    useless - a bash script that does basic maths\n',
  };

  /* ---------------- fake executables and services ---------------- */
  PROGRAMS.warm = async (ctx, args, node) => { if (args.includes('-h')) { ctx.out(`Welcome to the flag 'warm' program! The flag is: ${node.flag || ''}\n`); return 0; } ctx.out('Hello user! Pass me a -h to learn what I can do!\n'); return 0; };
  PROGRAMS.fang = async (ctx, args, node) => { ctx.out(`*ZAP!* ${node.flag || ''}\n`); return 0; };
  PROGRAMS.printer = async (ctx, args, node) => { ctx.out((node.text || '') + '\n'); return 0; };

  SERVICES['nc-lines'] = async (ctx, svc) => { // prints svc.lines (array) then holds the line open unless piped
    for (const l of svc.lines || []) ctx.out(l + '\n');
    if (!ctx.isPipe && svc.hold !== false) { await ctx.readLine({ prompt: '', spin: true }); }
    return 0;
  };
  SERVICES['nc-flood'] = async (ctx, svc) => { // lots of junk lines with the payload somewhere, keeps going until Ctrl+C
    const r = prng(svc.seed || 'flood'); const n = svc.count || 2000; const at = svc.insertAt != null ? svc.insertAt : Math.floor(n * 0.7);
    for (let i = 0; i < n; i++) ctx.out((i === at ? svc.line : (svc.junk || 'Not a flag') + ' ' + randWords(r, 3)) + '\n');
    if (!ctx.isPipe) { let k = n; await ctx.readLine({ prompt: '', spin: true, tick: () => { for (let j = 0; j < 20; j++) ctx.out((svc.junk || 'Not a flag') + ' ' + randWords(r, 3) + '\n'); k += 20; } }); }
    return 0;
  };
  SERVICES['ssh-shell'] = async (ctx, svc) => { // a full shell on another box (its own files)
    const fs = new FS(materialize(svc.files || {}, 'ssh:' + svc.host, svc.home || '/home/' + svc.user));
    const sub = new Session({ fs, user: svc.user, host: svc.hostname || svc.host.split('.')[0], home: svc.home || '/home/' + svc.user, challenge: ctx.session.challenge, restricted: !!svc.restricted });
    sub.noExit = !!svc.noExit;
    if (svc.motd) ctx.out(svc.motd + '\n');
    try { await ctx.shell.repl(sub); } catch (e) { if (!(e instanceof ExitShell)) throw e; }
    ctx.out('logout\n');
    return 0;
  };
  SERVICES['ssh-binary-search'] = async (ctx, svc) => {
    const r = prng(String(Date.now()) + Math.random()); const target = 1 + Math.floor(r() * 1000);
    ctx.out("Welcome to the Binary Search Game!\nI'm thinking of a number between 1 and 1000.\nCan you guess it in 10 tries?\n");
    for (let g = 1; g <= 10; g++) {
      const a = await ctx.readLine({ prompt: 'Enter your guess: ' }); if (a == null) return 0;
      const n = parseInt(a.trim(), 10);
      if (!/^-?\d+$/.test(a.trim())) { ctx.out('Please enter a valid number.\n'); g--; continue; }
      if (n === target) { ctx.out(`Congratulations! You guessed the correct number: ${target}\nHere's your flag: ${svc.flag}\n`); return 0; }
      ctx.out(n < target ? 'Higher! Try again.\n' : 'Lower! Try again.\n');
    }
    ctx.out(`Sorry, you've run out of guesses. The number was ${target}.\n`);
    return 0;
  };

  /* ---------------- REPL ---------------- */
  Shell.prototype.repl = async function (session) {
    for (;;) {
      let line;
      try { line = await this.io.readLine({ prompt: session.prompt(), session, complete: l => this.complete(session, l), history: session.history }); }
      catch (e) { if (e instanceof Interrupt) { this.io.write('^C\n'); continue; } throw e; }
      if (line == null) { this.io.write(session.noExit ? 'logout\n' : 'exit\n'); throw new ExitShell(0); }
      if (!line.trim()) continue;
      try { await this.runLine(session, line); }
      catch (e) { if (e instanceof Interrupt) { this.io.write('^C\n'); continue; } if (e instanceof ExitShell) throw e; this.io.write('bash: ' + (e.message || e) + '\n'); }
      if (this.io.afterCommand) this.io.afterCommand(session);
    }
  };

  global.CTFShell = { Shell, Session, FS, materialize, makeFile, Interrupt, ExitShell, parseLine, COMMANDS, BUILTINS, PROGRAMS, SERVICES, MAN, util: { b64encode, b64decode, prng, hashStr, joinPath, normalize, dirName, baseName, utf8ToBytes, bytesToUtf8 } };
})(typeof window !== 'undefined' ? window : globalThis);
