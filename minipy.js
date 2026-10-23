/* CTF Practice · MiniPy: a tiny Python 3 subset interpreter in JavaScript.
   Enough for the club's beginner scripts: functions, while/for/if, strings, lists,
   chr/ord/xor, input()/print(), open().read(), random.choice, sys.exit, and real-looking
   SyntaxError / IndentationError / NameError tracebacks. Async so input() can wait on the terminal. */
(function (global) {
  'use strict';

  class PyError extends Error { constructor(type, msg, extra) { super(msg); this.pyType = type; this.pyMsg = msg; this.extra = extra || {}; } }
  class PySyntaxError extends PyError { constructor(type, msg, line, text, col) { super(type, msg); this.line = line; this.text = text; this.col = col; } }
  class PyExit extends Error { constructor(code) { super('exit'); this.code = code; } }
  class BreakSignal { } class ContinueSignal { } class ReturnSignal { constructor(v) { this.v = v; } }

  class PyBytes { constructor(s) { this.s = s; } decode() { return bytesToStr(this.s); } }
  class PyTuple extends Array { }
  class PyFunction { constructor(name, params, defaults, body, closure) { this.name = name; this.params = params; this.defaults = defaults; this.body = body; this.closure = closure; } }
  class PyBuiltin { constructor(name, fn) { this.name = name; this.fn = fn; } }
  class PyModule { constructor(name, attrs) { this.name = name; this.attrs = attrs; } }
  class PyFile { constructor(name, data, mode) { this.name = name; this.data = data; this.mode = mode; this.closed = false; } }
  class PyRange { constructor(a, b, s) { this.a = a; this.b = b; this.s = s; } toArray() { const o = []; if (this.s > 0) for (let i = this.a; i < this.b; i += this.s) o.push(i); else for (let i = this.a; i > this.b; i += this.s) o.push(i); return o; } }

  function bytesToStr(b) { try { const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i) & 255; return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { throw new PyError('UnicodeDecodeError', "'utf-8' codec can't decode bytes: invalid start byte"); } }
  function strToBytes(s) { const u = new TextEncoder().encode(s); let o = ''; for (let i = 0; i < u.length; i++) o += String.fromCharCode(u[i]); return o; }

  /* ---------------- tokenizer ---------------- */
  const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'break', 'continue', 'def', 'elif', 'else', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'not', 'or', 'pass', 'return', 'while', 'try', 'except', 'finally', 'raise', 'lambda', 'class', 'with', 'del', 'assert', 'yield', 'nonlocal']);
  const OPS = ['**=', '//=', '<<', '>>', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '->', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '^', '&', '|', '~', '@'];

  function tokenize(src, filename) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const toks = []; const indents = [0]; let parenDepth = 0;
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln]; const lineno = ln + 1;
      let i = 0;
      if (parenDepth === 0) {
        // indentation
        let ind = 0; while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { ind += line[i] === '\t' ? 8 - (ind % 8) : 1; i++; }
        if (i >= line.length || line[i] === '#') continue; // blank or comment line
        if (ind > indents[indents.length - 1]) { indents.push(ind); toks.push({ t: 'INDENT', line: lineno, col: 0 }); }
        else {
          while (ind < indents[indents.length - 1]) { indents.pop(); toks.push({ t: 'DEDENT', line: lineno, col: 0 }); }
          if (ind !== indents[indents.length - 1]) throw new PySyntaxError('IndentationError', 'unindent does not match any outer indentation level', lineno, line, i);
        }
      }
      while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t') { i++; continue; }
        if (ch === '#') break;
        if (ch === '\\' && i === line.length - 1) { i++; break; }
        const col = i;
        if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++; const w = line.slice(i, j);
          if ((w === 'r' || w === 'b' || w === 'f' || w === 'rb' || w === 'br') && (line[j] === '"' || line[j] === "'")) { const r = readString(line, j, lineno, w); toks.push({ t: 'STR', v: r.v, prefix: w, line: lineno, col }); i = r.end; continue; }
          toks.push({ t: KEYWORDS.has(w) ? 'KW' : 'NAME', v: w, line: lineno, col }); i = j; continue; }
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) { let j = i; let v;
          if (line[i] === '0' && /[xX]/.test(line[i + 1] || '')) { j = i + 2; while (j < line.length && /[0-9a-fA-F_]/.test(line[j])) j++; v = parseInt(line.slice(i + 2, j).replace(/_/g, ''), 16); }
          else if (line[i] === '0' && /[bB]/.test(line[i + 1] || '')) { j = i + 2; while (j < line.length && /[01_]/.test(line[j])) j++; v = parseInt(line.slice(i + 2, j).replace(/_/g, ''), 2); }
          else if (line[i] === '0' && /[oO]/.test(line[i + 1] || '')) { j = i + 2; while (j < line.length && /[0-7_]/.test(line[j])) j++; v = parseInt(line.slice(i + 2, j).replace(/_/g, ''), 8); }
          else { while (j < line.length && /[0-9_.eE]/.test(line[j])) { if ((line[j] === 'e' || line[j] === 'E') && /[+-]/.test(line[j + 1] || '')) j++; j++; } v = Number(line.slice(i, j).replace(/_/g, '')); }
          if (/[A-Za-z_]/.test(line[j] || '')) throw new PySyntaxError('SyntaxError', 'invalid decimal literal', lineno, line, j);
          toks.push({ t: 'NUM', v, line: lineno, col }); i = j; continue; }
        if (ch === '"' || ch === "'") { const r = readString(line, i, lineno, ''); toks.push({ t: 'STR', v: r.v, prefix: '', line: lineno, col }); i = r.end; continue; }
        let op = null; for (const o of OPS) if (line.startsWith(o, i)) { op = o; break; }
        if (!op) throw new PySyntaxError('SyntaxError', `invalid character '${ch}' (U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`, lineno, line, i);
        if ('([{'.includes(op)) parenDepth++; if (')]}'.includes(op)) parenDepth = Math.max(0, parenDepth - 1);
        toks.push({ t: 'OP', v: op, line: lineno, col }); i += op.length;
      }
      if (parenDepth === 0 && toks.length && toks[toks.length - 1].t !== 'NEWLINE' && toks[toks.length - 1].t !== 'INDENT' && toks[toks.length - 1].t !== 'DEDENT') toks.push({ t: 'NEWLINE', line: lineno, col: line.length });
      else if (parenDepth === 0 && toks.length && (toks[toks.length - 1].t === 'INDENT' || toks[toks.length - 1].t === 'DEDENT')) toks.push({ t: 'NEWLINE', line: lineno, col: line.length });
    }
    if (parenDepth > 0) { const last = toks[toks.length - 1] || { line: lines.length }; throw new PySyntaxError('SyntaxError', "'(' was never closed", last.line, lines[last.line - 1] || '', 0); }
    while (indents.length > 1) { indents.pop(); toks.push({ t: 'DEDENT', line: lines.length + 1, col: 0 }); }
    toks.push({ t: 'EOF', line: lines.length + 1, col: 0 });
    return toks;
  }
  function readString(line, i, lineno, prefix) {
    const q = line[i]; const triple = line.startsWith(q + q + q, i);
    if (triple) throw new PySyntaxError('SyntaxError', 'triple-quoted strings are not supported on this machine', lineno, line, i);
    let j = i + 1, v = '';
    const raw = prefix.includes('r');
    while (j < line.length && line[j] !== q) {
      if (line[j] === '\\' && !raw) {
        const n = line[j + 1]; j += 2;
        if (n === 'n') v += '\n'; else if (n === 't') v += '\t'; else if (n === 'r') v += '\r'; else if (n === '0') v += '\0'; else if (n === '\\') v += '\\'; else if (n === "'") v += "'"; else if (n === '"') v += '"'; else if (n === 'a') v += '\x07'; else if (n === 'b') v += '\b';
        else if (n === 'x') { v += String.fromCharCode(parseInt(line.slice(j, j + 2), 16)); j += 2; }
        else if (n === 'u') { v += String.fromCharCode(parseInt(line.slice(j, j + 4), 16)); j += 4; }
        else if (n === undefined) throw new PySyntaxError('SyntaxError', 'unterminated string literal (detected at line ' + lineno + ')', lineno, line, i);
        else v += '\\' + n;
        continue;
      }
      v += line[j++];
    }
    if (j >= line.length) throw new PySyntaxError('SyntaxError', `unterminated string literal (detected at line ${lineno})`, lineno, line, i);
    return { v: prefix.includes('b') ? new PyBytes(v) : v, end: j + 1 };
  }

  /* ---------------- parser ---------------- */
  class Parser {
    constructor(toks, lines) { this.toks = toks; this.i = 0; this.lines = lines; }
    peek(k) { return this.toks[this.i + (k || 0)]; }
    next() { return this.toks[this.i++]; }
    at(t, v) { const k = this.peek(); return k.t === t && (v === undefined || k.v === v); }
    atOp(v) { return this.at('OP', v); } atKw(v) { return this.at('KW', v); }
    err(msg, tok) { tok = tok || this.peek(); throw new PySyntaxError('SyntaxError', msg, tok.line, this.lines[tok.line - 1] || '', tok.col); }
    expect(t, v, msg) { if (!this.at(t, v)) this.err(msg || 'invalid syntax'); return this.next(); }
    parseModule() { const body = []; while (!this.at('EOF')) { if (this.at('NEWLINE') || this.atOp(';')) { this.next(); continue; } body.push(this.parseStatement()); } return { type: 'Module', body }; }
    parseBlock() {
      this.expect('OP', ':', 'expected \':\'');
      if (!this.at('NEWLINE')) { const s = this.parseSimpleLine(); return s; }
      this.next();
      const tok = this.peek();
      if (!this.at('INDENT')) this.err('expected an indented block after ' + "'" + (this.lastHeader || 'statement') + "' statement on line " + (this.lastHeaderLine || tok.line), tok);
      this.next(); const body = [];
      while (!this.at('DEDENT') && !this.at('EOF')) { if (this.at('NEWLINE') || this.atOp(';')) { this.next(); continue; } body.push(this.parseStatement()); }
      if (this.at('DEDENT')) this.next();
      return body;
    }
    parseStatement() {
      const tok = this.peek();
      if (tok.t === 'INDENT') throw new PySyntaxError('IndentationError', 'unexpected indent', tok.line, this.lines[tok.line - 1] || '', 0);
      if (tok.t === 'KW') {
        switch (tok.v) {
          case 'if': return this.parseIf();
          case 'while': { this.next(); this.lastHeader = 'while'; this.lastHeaderLine = tok.line; const test = this.parseTest(); const body = this.parseBlock(); let orelse = null; if (this.atKw('else')) { this.next(); orelse = this.parseBlock(); } return { type: 'While', test, body, orelse, line: tok.line }; }
          case 'for': { this.next(); this.lastHeader = 'for'; this.lastHeaderLine = tok.line; const target = this.parseTargetList(); this.expect('KW', 'in'); const iter = this.parseTestList(); const body = this.parseBlock(); return { type: 'For', target, iter, body, line: tok.line }; }
          case 'def': { this.next(); this.lastHeader = 'function definition'; this.lastHeaderLine = tok.line; const name = this.expect('NAME').v; this.expect('OP', '('); const params = [], defaults = []; while (!this.atOp(')')) { const p = this.expect('NAME').v; params.push(p); if (this.atOp('=')) { this.next(); defaults.push(this.parseTest()); } else defaults.push(undefined); if (this.atOp(',')) this.next(); else break; } this.expect('OP', ')'); if (this.atOp('->')) { this.next(); this.parseTest(); } const body = this.parseBlock(); return { type: 'Def', name, params, defaults, body, line: tok.line }; }
          case 'return': { this.next(); let value = null; if (!this.at('NEWLINE') && !this.atOp(';')) value = this.parseTestList(); this.endSimple(); return { type: 'Return', value, line: tok.line }; }
          case 'pass': this.next(); this.endSimple(); return { type: 'Pass', line: tok.line };
          case 'break': this.next(); this.endSimple(); return { type: 'Break', line: tok.line };
          case 'continue': this.next(); this.endSimple(); return { type: 'Continue', line: tok.line };
          case 'import': { this.next(); const names = []; do { const n = this.expect('NAME').v; let alias = n; if (this.atKw('as')) { this.next(); alias = this.expect('NAME').v; } names.push({ name: n, alias }); if (this.atOp(',')) this.next(); else break; } while (true); this.endSimple(); return { type: 'Import', names, line: tok.line }; }
          case 'from': { this.next(); const mod = this.expect('NAME').v; this.expect('KW', 'import'); const names = []; if (this.atOp('*')) { this.next(); names.push({ name: '*', alias: '*' }); } else do { const n = this.expect('NAME').v; let alias = n; if (this.atKw('as')) { this.next(); alias = this.expect('NAME').v; } names.push({ name: n, alias }); if (this.atOp(',')) this.next(); else break; } while (true); this.endSimple(); return { type: 'FromImport', mod, names, line: tok.line }; }
          case 'global': case 'nonlocal': { this.next(); const names = [this.expect('NAME').v]; while (this.atOp(',')) { this.next(); names.push(this.expect('NAME').v); } this.endSimple(); return { type: 'Global', names, line: tok.line }; }
          case 'try': { this.next(); this.lastHeader = 'try'; this.lastHeaderLine = tok.line; const body = this.parseBlock(); const handlers = []; let orelse = null, finalbody = null; while (this.atKw('except')) { const et = this.next(); let typeName = null, asName = null; if (!this.atOp(':')) { typeName = this.parseTest(); if (this.atKw('as')) { this.next(); asName = this.expect('NAME').v; } } this.lastHeader = 'except'; this.lastHeaderLine = et.line; handlers.push({ typeName, asName, body: this.parseBlock() }); } if (this.atKw('else')) { this.next(); orelse = this.parseBlock(); } if (this.atKw('finally')) { this.next(); finalbody = this.parseBlock(); } return { type: 'Try', body, handlers, orelse, finalbody, line: tok.line }; }
          case 'raise': { this.next(); let exc = null; if (!this.at('NEWLINE')) exc = this.parseTest(); this.endSimple(); return { type: 'Raise', exc, line: tok.line }; }
          case 'assert': { this.next(); const test = this.parseTest(); let msg = null; if (this.atOp(',')) { this.next(); msg = this.parseTest(); } this.endSimple(); return { type: 'Assert', test, msg, line: tok.line }; }
          case 'del': { this.next(); const target = this.parseTestList(); this.endSimple(); return { type: 'Del', target, line: tok.line }; }
          case 'class': this.err('classes are not supported on this machine');
          case 'with': this.err('with-statements are not supported on this machine (use open(...).read())');
          case 'elif': case 'else': case 'except': case 'finally': this.err('invalid syntax');
        }
      }
      return this.parseSimpleLine();
    }
    parseSimpleLine() {
      const stmts = [];
      for (;;) { stmts.push(this.parseSmall()); if (this.atOp(';')) { this.next(); if (this.at('NEWLINE') || this.at('EOF')) break; continue; } break; }
      if (!this.at('NEWLINE') && !this.at('EOF') && !this.at('DEDENT')) this.err('invalid syntax');
      if (this.at('NEWLINE')) this.next();
      return stmts.length === 1 ? stmts[0] : stmts;
    }
    endSimple() { if (this.atOp(';')) return; if (!this.at('NEWLINE') && !this.at('EOF') && !this.at('DEDENT')) this.err('invalid syntax'); if (this.at('NEWLINE')) this.next(); }
    parseSmall() {
      const tok = this.peek();
      if (tok.t === 'KW' && ['pass', 'break', 'continue', 'return', 'import', 'from', 'global', 'raise', 'assert', 'del'].includes(tok.v)) { const s = this.parseStatement(); this.i--; if (!this.at('NEWLINE')) this.i++; return s; }
      const start = this.i; const expr = this.parseTestList();
      if (this.atOp('=')) {
        const targets = [expr];
        while (this.atOp('=')) { this.next(); targets.push(this.parseTestList()); }
        const value = targets.pop();
        for (const t of targets) this.checkTarget(t, this.toks[start]);
        return { type: 'Assign', targets, value, line: tok.line };
      }
      const aug = this.peek(); if (aug.t === 'OP' && ['+=', '-=', '*=', '/=', '%=', '//=', '**='].includes(aug.v)) { this.next(); this.checkTarget(expr, this.toks[start]); const value = this.parseTestList(); return { type: 'AugAssign', target: expr, op: aug.v.slice(0, -1), value, line: tok.line }; }
      return { type: 'Expr', value: expr, line: tok.line };
    }
    checkTarget(t, tok) { if (!['Name', 'Subscript', 'Attribute', 'Tuple', 'List'].includes(t.type)) this.err("cannot assign to " + (t.type === 'Call' ? 'function call here. Maybe you meant \'==\' instead of \'=\'?' : t.type === 'Constant' ? 'literal here. Maybe you meant \'==\' instead of \'=\'?' : 'expression here. Maybe you meant \'==\' instead of \'=\'?'), tok); }
    parseIf() {
      const tok = this.next(); this.lastHeader = tok.v === 'if' ? 'if' : 'elif'; this.lastHeaderLine = tok.line;
      const testTok = this.peek();
      const test = this.parseTest();
      if (this.atOp('=')) { const e = this.peek(); const lineText = this.lines[e.line - 1] || ''; const colon = lineText.lastIndexOf(':'); const end = colon > e.col ? lineText.slice(0, colon).replace(/\s+$/, '').length : lineText.replace(/\s+$/, '').length; const err = new PySyntaxError('SyntaxError', "invalid syntax. Maybe you meant '==' or ':=' instead of '='?", e.line, lineText, testTok.col); err.span = Math.max(1, end - testTok.col); throw err; }
      const body = this.parseBlock(); let orelse = null;
      if (this.atKw('elif')) orelse = [this.parseIf()];
      else if (this.atKw('else')) { this.next(); orelse = this.parseBlock(); }
      return { type: 'If', test, body, orelse, line: tok.line };
    }
    parseTargetList() { const first = this.parseTarget(); if (!this.atOp(',')) return first; const items = [first]; while (this.atOp(',')) { this.next(); if (this.atKw('in')) break; items.push(this.parseTarget()); } return { type: 'Tuple', elts: items }; }
    parseTarget() { if (this.atOp('(')) { this.next(); const t = this.parseTargetList(); this.expect('OP', ')'); return t; } if (this.atOp('[')) { this.next(); const t = this.parseTargetList(); this.expect('OP', ']'); return t; } return this.parsePrimary(); }
    parseTestList() { const first = this.parseTest(); if (!this.atOp(',')) return first; const elts = [first]; while (this.atOp(',')) { this.next(); if (this.at('NEWLINE') || this.atOp(')') || this.atOp('=') || this.at('EOF')) break; elts.push(this.parseTest()); } return { type: 'Tuple', elts, line: first.line }; }
    parseTest() {
      const e = this.parseOr();
      if (this.atKw('if')) { this.next(); const test = this.parseOr(); this.expect('KW', 'else'); const orelse = this.parseTest(); return { type: 'IfExp', test, body: e, orelse, line: e.line }; }
      if (this.atKw('lambda')) this.err('lambda is not supported on this machine');
      return e;
    }
    parseOr() { let l = this.parseAnd(); while (this.atKw('or')) { this.next(); l = { type: 'BoolOp', op: 'or', left: l, right: this.parseAnd(), line: l.line }; } return l; }
    parseAnd() { let l = this.parseNot(); while (this.atKw('and')) { this.next(); l = { type: 'BoolOp', op: 'and', left: l, right: this.parseNot(), line: l.line }; } return l; }
    parseNot() { if (this.atKw('not')) { const t = this.next(); return { type: 'UnaryOp', op: 'not', operand: this.parseNot(), line: t.line }; } return this.parseComparison(); }
    parseComparison() {
      let l = this.parseBitOr(); const ops = [], rights = [];
      for (;;) {
        let op = null;
        if (this.at('OP') && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().v)) op = this.next().v;
        else if (this.atKw('in')) { this.next(); op = 'in'; }
        else if (this.atKw('not') && this.peek(1).t === 'KW' && this.peek(1).v === 'in') { this.next(); this.next(); op = 'not in'; }
        else if (this.atKw('is')) { this.next(); if (this.atKw('not')) { this.next(); op = 'is not'; } else op = 'is'; }
        if (!op) break; ops.push(op); rights.push(this.parseBitOr());
      }
      return ops.length ? { type: 'Compare', left: l, ops, rights, line: l.line } : l;
    }
    parseBitOr() { let l = this.parseBitXor(); while (this.atOp('|')) { this.next(); l = { type: 'BinOp', op: '|', left: l, right: this.parseBitXor(), line: l.line }; } return l; }
    parseBitXor() { let l = this.parseBitAnd(); while (this.atOp('^')) { this.next(); l = { type: 'BinOp', op: '^', left: l, right: this.parseBitAnd(), line: l.line }; } return l; }
    parseBitAnd() { let l = this.parseShift(); while (this.atOp('&')) { this.next(); l = { type: 'BinOp', op: '&', left: l, right: this.parseShift(), line: l.line }; } return l; }
    parseShift() { let l = this.parseArith(); while (this.atOp('<<') || this.atOp('>>')) { const op = this.next().v; l = { type: 'BinOp', op, left: l, right: this.parseArith(), line: l.line }; } return l; }
    parseArith() { let l = this.parseTerm(); while (this.atOp('+') || this.atOp('-')) { const op = this.next().v; l = { type: 'BinOp', op, left: l, right: this.parseTerm(), line: l.line }; } return l; }
    parseTerm() { let l = this.parseFactor(); while (this.at('OP') && ['*', '/', '//', '%'].includes(this.peek().v)) { const op = this.next().v; l = { type: 'BinOp', op, left: l, right: this.parseFactor(), line: l.line }; } return l; }
    parseFactor() { if (this.at('OP') && ['-', '+', '~'].includes(this.peek().v)) { const t = this.next(); return { type: 'UnaryOp', op: t.v, operand: this.parseFactor(), line: t.line }; } return this.parsePower(); }
    parsePower() { const b = this.parsePrimary(); if (this.atOp('**')) { this.next(); return { type: 'BinOp', op: '**', left: b, right: this.parseFactor(), line: b.line }; } return b; }
    parsePrimary() {
      let e = this.parseAtom();
      for (;;) {
        if (this.atOp('(')) { const t = this.next(); const args = [], kwargs = []; while (!this.atOp(')')) { if (this.at('NAME') && this.peek(1).t === 'OP' && this.peek(1).v === '=') { const k = this.next().v; this.next(); kwargs.push({ name: k, value: this.parseTest() }); } else if (this.atOp('*')) { this.next(); args.push({ type: 'Starred', value: this.parseTest() }); } else { const a = this.parseTest(); if (this.atKw('for')) { args.push(this.parseCompTail(a, 'list')); } else args.push(a); } if (this.atOp(',')) this.next(); else break; } if (!this.atOp(')')) this.err('invalid syntax. Perhaps you forgot a comma?'); this.next(); e = { type: 'Call', func: e, args, kwargs, line: e.line || t.line }; continue; }
        if (this.atOp('[')) { this.next(); let lo = null, hi = null, step = null, isSlice = false; if (!this.atOp(':')) lo = this.parseTest(); if (this.atOp(':')) { isSlice = true; this.next(); if (!this.atOp(']') && !this.atOp(':')) hi = this.parseTest(); if (this.atOp(':')) { this.next(); if (!this.atOp(']')) step = this.parseTest(); } } this.expect('OP', ']'); e = isSlice ? { type: 'Slice', value: e, lo, hi, step, line: e.line } : { type: 'Subscript', value: e, index: lo, line: e.line }; continue; }
        if (this.atOp('.')) { this.next(); const n = this.expect('NAME', undefined, 'invalid syntax').v; e = { type: 'Attribute', value: e, attr: n, line: e.line }; continue; }
        break;
      }
      return e;
    }
    parseCompTail(elt, kind) {
      const gens = [];
      while (this.atKw('for')) { this.next(); const target = this.parseTargetList(); this.expect('KW', 'in'); const iter = this.parseOr(); const ifs = []; while (this.atKw('if')) { this.next(); ifs.push(this.parseOr()); } gens.push({ target, iter, ifs }); }
      return { type: 'Comp', kind, elt, gens, line: elt.line };
    }
    parseAtom() {
      const t = this.peek();
      if (t.t === 'NUM') { this.next(); return { type: 'Constant', value: t.v, line: t.line }; }
      if (t.t === 'STR') { this.next(); let v = t.v; let fstr = t.prefix.includes('f'); while (this.at('STR')) { const n = this.next(); if (n.prefix.includes('f')) fstr = true; v = (v instanceof PyBytes ? new PyBytes(v.s + n.v.s) : v + n.v); } return fstr ? { type: 'FString', value: v, line: t.line } : { type: 'Constant', value: v, line: t.line }; }
      if (t.t === 'NAME') { this.next(); return { type: 'Name', id: t.v, line: t.line }; }
      if (t.t === 'KW') { if (t.v === 'True') { this.next(); return { type: 'Constant', value: true, line: t.line }; } if (t.v === 'False') { this.next(); return { type: 'Constant', value: false, line: t.line }; } if (t.v === 'None') { this.next(); return { type: 'Constant', value: null, line: t.line }; } this.err('invalid syntax'); }
      if (t.t === 'OP' && t.v === '(') { this.next(); if (this.atOp(')')) { this.next(); return { type: 'Tuple', elts: [], line: t.line }; } const first = this.parseTest(); if (this.atKw('for')) { const c = this.parseCompTail(first, 'list'); this.expect('OP', ')'); return c; } if (this.atOp(',')) { const elts = [first]; while (this.atOp(',')) { this.next(); if (this.atOp(')')) break; elts.push(this.parseTest()); } this.expect('OP', ')'); return { type: 'Tuple', elts, line: t.line }; } if (!this.atOp(')')) this.err("'(' was never closed"); this.next(); return first; }
      if (t.t === 'OP' && t.v === '[') { this.next(); const elts = []; if (!this.atOp(']')) { const first = this.parseTest(); if (this.atKw('for')) { const c = this.parseCompTail(first, 'list'); this.expect('OP', ']'); return c; } elts.push(first); while (this.atOp(',')) { this.next(); if (this.atOp(']')) break; elts.push(this.parseTest()); } } if (!this.atOp(']')) this.err("'[' was never closed"); this.next(); return { type: 'List', elts, line: t.line }; }
      if (t.t === 'OP' && t.v === '{') { this.next(); const keys = [], values = []; while (!this.atOp('}')) { const k = this.parseTest(); if (this.atOp(':')) { this.next(); keys.push(k); values.push(this.parseTest()); } else { keys.push(null); values.push(k); } if (this.atOp(',')) this.next(); else break; } this.expect('OP', '}'); return keys.some(k => k === null) ? { type: 'Set', elts: values, line: t.line } : { type: 'Dict', keys, values, line: t.line }; }
      if (t.t === 'NEWLINE' || t.t === 'EOF') this.err('invalid syntax', t);
      if (t.t === 'INDENT') throw new PySyntaxError('IndentationError', 'unexpected indent', t.line, this.lines[t.line - 1] || '', 0);
      this.err('invalid syntax', t);
    }
  }

  /* ---------------- interpreter ---------------- */
  const MAX_STEPS = 4000000;
  function typeName(v) { if (v === null || v === undefined) return 'NoneType'; if (typeof v === 'boolean') return 'bool'; if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'; if (typeof v === 'string') return 'str'; if (v instanceof PyBytes) return 'bytes'; if (v instanceof PyTuple) return 'tuple'; if (Array.isArray(v)) return 'list'; if (v instanceof Map) return 'dict'; if (v instanceof Set) return 'set'; if (v instanceof PyFunction || v instanceof PyBuiltin) return 'function'; if (v instanceof PyModule) return 'module'; if (v instanceof PyRange) return 'range'; if (v instanceof PyFile) return '_io.TextIOWrapper'; return 'object'; }
  function truthy(v) { if (v === null || v === undefined || v === false || v === 0 || v === '') return false; if (Array.isArray(v)) return v.length > 0; if (v instanceof Map || v instanceof Set) return v.size > 0; if (v instanceof PyBytes) return v.s.length > 0; return true; }
  function repr(v) {
    if (v === null || v === undefined) return 'None'; if (v === true) return 'True'; if (v === false) return 'False';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (String(v).includes('.') || String(v).includes('e') ? String(v) : v + '.0');
    if (typeof v === 'string') { const q = v.includes("'") && !v.includes('"') ? '"' : "'"; return q + v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(new RegExp(q, 'g'), '\\' + q) + q; }
    if (v instanceof PyBytes) return "b'" + v.s.split('').map(c => { const k = c.charCodeAt(0); if (c === '\\') return '\\\\'; if (c === "'") return "\\'"; if (c === '\n') return '\\n'; if (c === '\t') return '\\t'; if (c === '\r') return '\\r'; return k >= 32 && k < 127 ? c : '\\x' + k.toString(16).padStart(2, '0'); }).join('') + "'";
    if (v instanceof PyTuple) return '(' + v.map(repr).join(', ') + (v.length === 1 ? ',' : '') + ')';
    if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
    if (v instanceof Map) return '{' + [...v.entries()].map(([k, x]) => repr(k) + ': ' + repr(x)).join(', ') + '}';
    if (v instanceof Set) return v.size ? '{' + [...v].map(repr).join(', ') + '}' : 'set()';
    if (v instanceof PyFunction) return `<function ${v.name} at 0x7f3a1c0b5e40>`; if (v instanceof PyBuiltin) return `<built-in function ${v.name}>`;
    if (v instanceof PyModule) return `<module '${v.name}'>`; if (v instanceof PyRange) return `range(${v.a}, ${v.b}${v.s !== 1 ? ', ' + v.s : ''})`;
    if (v instanceof PyFile) return `<_io.TextIOWrapper name='${v.name}' mode='${v.mode}' encoding='UTF-8'>`;
    if (v instanceof PyError) return `${v.pyType}(${repr(v.pyMsg)})`;
    return String(v);
  }
  function str(v) { if (typeof v === 'string') return v; if (v instanceof PyError) return v.pyMsg; return repr(v); }
  function pyEq(a, b) { if (a instanceof PyBytes && b instanceof PyBytes) return a.s === b.s; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i])); if (typeof a === 'boolean' && typeof b === 'number') return (a ? 1 : 0) === b; if (typeof b === 'boolean' && typeof a === 'number') return (b ? 1 : 0) === a; return a === b; }
  function hashKey(k) { if (typeof k === 'string') return 's:' + k; if (typeof k === 'number' || typeof k === 'boolean') return 'n:' + Number(k); if (k === null) return 'None'; if (k instanceof PyTuple) return 't:' + k.map(hashKey).join(','); throw new PyError('TypeError', `unhashable type: '${typeName(k)}'`); }
  function iterate(v) { if (typeof v === 'string') return Array.from(v); if (Array.isArray(v)) return v; if (v instanceof PyRange) return v.toArray(); if (v instanceof Map) return [...v.keys()]; if (v instanceof Set) return [...v]; if (v instanceof PyBytes) return v.s.split('').map(c => c.charCodeAt(0)); if (v instanceof PyFile) return v.data.split('\n').map((l, i, a) => i < a.length - 1 ? l + '\n' : l).filter((l, i, a) => !(i === a.length - 1 && l === '')); throw new PyError('TypeError', `'${typeName(v)}' object is not iterable`); }
  function toInt(v) { if (typeof v === 'boolean') return v ? 1 : 0; if (typeof v === 'number') return Math.trunc(v); throw new PyError('TypeError', `'${typeName(v)}' object cannot be interpreted as an integer`); }
  function pyMod(a, b) { if (b === 0) throw new PyError('ZeroDivisionError', 'integer modulo by zero'); const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; }
  function fmtPercent(fmt, args) { const list = Array.isArray(args) ? args : [args]; let i = 0; return fmt.replace(/%(-?\d*)(\.\d+)?([sdifx%])/g, (m, w, p, c) => { if (c === '%') return '%'; let v = list[i++]; let s; if (c === 's') s = str(v); else if (c === 'd' || c === 'i') s = String(toInt(v)); else if (c === 'f') s = Number(v).toFixed(p ? parseInt(p.slice(1), 10) : 6); else if (c === 'x') s = toInt(v).toString(16); if (w) { const n = parseInt(w, 10); s = n < 0 ? s.padEnd(-n) : s.padStart(n); } return s; }); }

  class Frame { constructor(name, vars, parent) { this.name = name; this.vars = vars; this.parent = parent; this.line = 0; this.globalsDecl = new Set(); } }

  class Interpreter {
    constructor(io) { this.io = io; this.steps = 0; this.stack = []; this.filename = '<stdin>'; this.source = ''; this.files = io.files || { read: () => null, write: () => false }; }

    makeGlobals(argv) {
      const self = this; const g = new Map();
      const B = (name, fn) => g.set(name, new PyBuiltin(name, fn));
      g.set('__name__', '__main__'); g.set('__file__', this.filename);
      B('print', async (args, kw) => { const sep = kw.has('sep') ? str(kw.get('sep')) : ' '; const end = kw.has('end') ? str(kw.get('end')) : '\n'; self.io.write(args.map(str).join(sep) + end); return null; });
      B('input', async (args) => { const prompt = args.length ? str(args[0]) : ''; self.io.write(prompt); const line = await self.io.readLine({ prompt: '' }); if (line == null) throw new PyError('EOFError', 'EOF when reading a line'); return line; });
      B('len', async ([v]) => { if (typeof v === 'string' || Array.isArray(v)) return v.length; if (v instanceof PyBytes) return v.s.length; if (v instanceof Map || v instanceof Set) return v.size; if (v instanceof PyRange) return v.toArray().length; throw new PyError('TypeError', `object of type '${typeName(v)}' has no len()`); });
      B('chr', async ([v]) => { const n = toInt(v); if (n < 0 || n > 0x10ffff) throw new PyError('ValueError', 'chr() arg not in range(0x110000)'); return String.fromCodePoint(n); });
      B('ord', async ([v]) => { if (typeof v !== 'string' || Array.from(v).length !== 1) throw new PyError('TypeError', `ord() expected a character, but string of length ${typeof v === 'string' ? Array.from(v).length : 0} found`); return v.codePointAt(0); });
      B('int', async ([v, base]) => { if (v === undefined) return 0; if (typeof v === 'number') return Math.trunc(v); if (typeof v === 'boolean') return v ? 1 : 0; if (typeof v === 'string') { const t = v.trim(); const b = base === undefined ? 10 : toInt(base); const n = b === 10 ? (/^[+-]?\d+$/.test(t) ? parseInt(t, 10) : NaN) : parseInt(t.replace(/^0[xXbBoO]/, ''), b); if (Number.isNaN(n)) throw new PyError('ValueError', `invalid literal for int() with base ${b}: ${repr(v)}`); return n; } throw new PyError('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`); });
      B('float', async ([v]) => { if (typeof v === 'string') { const n = Number(v.trim()); if (Number.isNaN(n)) throw new PyError('ValueError', `could not convert string to float: ${repr(v)}`); return n; } return Number(v); });
      B('str', async ([v]) => v === undefined ? '' : str(v));
      B('repr', async ([v]) => repr(v));
      B('bool', async ([v]) => truthy(v));
      B('list', async ([v]) => v === undefined ? [] : [...iterate(v)]);
      B('tuple', async ([v]) => PyTuple.from(v === undefined ? [] : iterate(v)));
      B('set', async ([v]) => new Set(v === undefined ? [] : iterate(v)));
      B('dict', async ([v]) => { const m = new Map(); if (v instanceof Map) for (const [k, x] of v) m.set(k, x); else if (v) for (const kv of iterate(v)) m.set(kv[0], kv[1]); return m; });
      B('range', async (a) => { const n = a.map(toInt); if (n.length === 1) return new PyRange(0, n[0], 1); if (n.length === 2) return new PyRange(n[0], n[1], 1); if (n[2] === 0) throw new PyError('ValueError', 'range() arg 3 must not be zero'); return new PyRange(n[0], n[1], n[2]); });
      B('zip', async (a) => { const its = a.map(iterate); const n = its.length ? Math.min(...its.map(x => x.length)) : 0; const o = []; for (let i = 0; i < n; i++) o.push(PyTuple.from(its.map(x => x[i]))); return o; });
      B('enumerate', async ([v, start]) => iterate(v).map((x, i) => PyTuple.from([i + (start || 0), x])));
      B('reversed', async ([v]) => [...iterate(v)].reverse());
      B('sorted', async ([v], kw) => { const o = [...iterate(v)]; o.sort((x, y) => (typeof x === 'string' ? (x < y ? -1 : x > y ? 1 : 0) : x - y)); if (kw.get('reverse')) o.reverse(); return o; });
      B('sum', async ([v, start]) => iterate(v).reduce((s, x) => s + x, start || 0));
      B('min', async (a) => { const v = a.length === 1 ? iterate(a[0]) : a; return v.reduce((m, x) => (x < m ? x : m)); });
      B('max', async (a) => { const v = a.length === 1 ? iterate(a[0]) : a; return v.reduce((m, x) => (x > m ? x : m)); });
      B('abs', async ([v]) => Math.abs(v));
      B('round', async ([v, d]) => d ? Number(v.toFixed(d)) : Math.round(v));
      B('hex', async ([v]) => (v < 0 ? '-0x' : '0x') + Math.abs(toInt(v)).toString(16));
      B('bin', async ([v]) => (v < 0 ? '-0b' : '0b') + Math.abs(toInt(v)).toString(2));
      B('oct', async ([v]) => (v < 0 ? '-0o' : '0o') + Math.abs(toInt(v)).toString(8));
      B('type', async ([v]) => `<class '${typeName(v)}'>`);
      B('isinstance', async ([v, t]) => { const n = typeName(v); const want = String(t).replace(/<class '(.*)'>/, '$1'); return n === want || (want === 'int' && typeof v === 'boolean'); });
      B('any', async ([v]) => iterate(v).some(truthy)); B('all', async ([v]) => iterate(v).every(truthy));
      B('exit', async ([c]) => { throw new PyExit(c == null ? 0 : c); }); B('quit', async ([c]) => { throw new PyExit(c == null ? 0 : c); });
      B('open', async ([name, mode]) => { mode = mode === undefined ? 'r' : str(mode); const n = str(name); if (mode.includes('w') || mode.includes('a')) { return new PyFile(n, '', mode); } const f = self.files.read(n); if (f == null) throw new PyError('FileNotFoundError', `[Errno 2] No such file or directory: ${repr(n)}`); if (f.isDir) throw new PyError('IsADirectoryError', `[Errno 21] Is a directory: ${repr(n)}`); return new PyFile(n, mode.includes('b') ? new PyBytes(f.bin ? f.data : strToBytes(f.data)) : (f.bin ? bytesToStr(f.data) : f.data), mode); });
      B('bytes', async ([v, enc]) => { if (typeof v === 'string') return new PyBytes(strToBytes(v)); if (Array.isArray(v)) return new PyBytes(v.map(x => String.fromCharCode(x)).join('')); if (v instanceof PyBytes) return v; return new PyBytes(''); });
      B('help', async () => { self.io.write('This is a tiny Python for the club machine. Try: print(), input(), len(), chr(), ord(), int(), str(), range(), open()\n'); return null; });
      B('id', async ([v]) => 140000000000 + (hashKeySafe(v) % 1000000) * 16);
      B('hash', async ([v]) => hashKeySafe(v));
      B('callable', async ([v]) => v instanceof PyFunction || v instanceof PyBuiltin);
      B('globals', async () => g);
      B('map', async ([f, v]) => { const o = []; for (const x of iterate(v)) o.push(await self.call(f, [x], new Map())); return o; });
      B('filter', async ([f, v]) => { const o = []; for (const x of iterate(v)) if (truthy(f === null ? x : await self.call(f, [x], new Map()))) o.push(x); return o; });
      B('format', async ([v, spec]) => self.formatSpec(v, spec || ''));
      B('divmod', async ([a, b]) => PyTuple.from([Math.floor(a / b), pyMod(a, b)]));
      B('pow', async ([a, b, m]) => m === undefined ? Math.pow(a, b) : modPow(toInt(a), toInt(b), toInt(m)));
      const modules = {
        random: new PyModule('random', new Map([
          ['choice', new PyBuiltin('choice', async ([v]) => { const a = iterate(v); if (!a.length) throw new PyError('IndexError', 'Cannot choose from an empty sequence'); return a[Math.floor(Math.random() * a.length)]; })],
          ['randint', new PyBuiltin('randint', async ([a, b]) => a + Math.floor(Math.random() * (b - a + 1)))],
          ['random', new PyBuiltin('random', async () => Math.random())],
          ['shuffle', new PyBuiltin('shuffle', async ([v]) => { for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [v[i], v[j]] = [v[j], v[i]]; } return null; })],
          ['seed', new PyBuiltin('seed', async () => null)],
        ])),
        sys: new PyModule('sys', new Map([
          ['exit', new PyBuiltin('exit', async ([c]) => { throw new PyExit(c == null ? 0 : c); })],
          ['argv', (argv || ['']).slice()],
          ['version', '3.11.2 (main, club practice machine)'],
          ['stdin', new PyModule('stdin', new Map([['read', new PyBuiltin('read', async () => { if (self.io.stdinText != null) { const t = self.io.stdinText; self.io.stdinText = ''; return t; } const lines = []; for (;;) { const l = await self.io.readLine({ prompt: '' }); if (l == null) break; lines.push(l); } return lines.join('\n') + (lines.length ? '\n' : ''); })], ['readline', new PyBuiltin('readline', async () => { if (self.io.stdinText != null) { const t = self.io.stdinText; const i = t.indexOf('\n'); const line = i < 0 ? t : t.slice(0, i + 1); self.io.stdinText = i < 0 ? '' : t.slice(i + 1); return line; } const l = await self.io.readLine({ prompt: '' }); return l == null ? '' : l + '\n'; })], ['readlines', new PyBuiltin('readlines', async () => { const t = self.io.stdinText != null ? self.io.stdinText : ''; self.io.stdinText = ''; return t.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).map(l => l + '\n'); })]]))],
          ['stdout', new PyModule('stdout', new Map([['write', new PyBuiltin('write', async ([s]) => { self.io.write(str(s)); return str(s).length; })], ['flush', new PyBuiltin('flush', async () => null)]]))],
        ])),
        os: new PyModule('os', new Map([['getcwd', new PyBuiltin('getcwd', async () => self.files.cwd ? self.files.cwd() : '/home/ctf')], ['listdir', new PyBuiltin('listdir', async ([p]) => self.files.listdir ? self.files.listdir(p === undefined ? '.' : str(p)) : [])], ['system', new PyBuiltin('system', async () => 0)], ['getenv', new PyBuiltin('getenv', async () => null)], ['sep', '/'], ['name', 'posix']])),
        time: new PyModule('time', new Map([['time', new PyBuiltin('time', async () => Date.now() / 1000)], ['sleep', new PyBuiltin('sleep', async () => null)]])),
        math: new PyModule('math', new Map([['sqrt', new PyBuiltin('sqrt', async ([v]) => Math.sqrt(v))], ['floor', new PyBuiltin('floor', async ([v]) => Math.floor(v))], ['ceil', new PyBuiltin('ceil', async ([v]) => Math.ceil(v))], ['pi', Math.PI], ['e', Math.E], ['gcd', new PyBuiltin('gcd', async ([a, b]) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; })], ['log', new PyBuiltin('log', async ([v, b]) => b ? Math.log(v) / Math.log(b) : Math.log(v))], ['log2', new PyBuiltin('log2', async ([v]) => Math.log2(v))], ['pow', new PyBuiltin('pow', async ([a, b]) => Math.pow(a, b))]])),
        string: new PyModule('string', new Map([['ascii_lowercase', 'abcdefghijklmnopqrstuvwxyz'], ['ascii_uppercase', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'], ['ascii_letters', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'], ['digits', '0123456789'], ['punctuation', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']])),
        base64: new PyModule('base64', new Map([['b64decode', new PyBuiltin('b64decode', async ([v]) => new PyBytes(atob((v instanceof PyBytes ? v.s : str(v)).replace(/[^A-Za-z0-9+/=]/g, ''))))], ['b64encode', new PyBuiltin('b64encode', async ([v]) => new PyBytes(btoa(v instanceof PyBytes ? v.s : strToBytes(str(v)))))]])),
        itertools: new PyModule('itertools', new Map([['cycle', new PyBuiltin('cycle', async ([v]) => { const a = iterate(v); const o = []; for (let i = 0; i < 100000 && a.length; i++) o.push(a[i % a.length]); return o; })]])),
        binascii: new PyModule('binascii', new Map([['hexlify', new PyBuiltin('hexlify', async ([v]) => new PyBytes(v.s.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')))], ['unhexlify', new PyBuiltin('unhexlify', async ([v]) => new PyBytes((v instanceof PyBytes ? v.s : str(v)).match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join('')))]])),
      };
      this.modules = modules;
      return g;
    }

    importModule(name) { const m = this.modules[name]; if (!m) throw new PyError('ModuleNotFoundError', `No module named '${name}'`); return m; }

    // ---- running ----
    async runSource(src, filename, argv) {
      this.filename = filename; this.source = src; const lines = src.split('\n');
      let ast;
      try { const toks = tokenize(src, filename); ast = new Parser(toks, lines).parseModule(); }
      catch (e) { if (e instanceof PySyntaxError) { this.printSyntaxError(e, filename, lines); return 1; } throw e; }
      const g = this.makeGlobals(argv); this.globals = g;
      const frame = new Frame('<module>', g, null); this.stack = [frame];
      try { await this.execBlock(ast.body, frame); return 0; }
      catch (e) { return this.handleTopError(e, filename, lines); }
    }
    async runInteractiveLine(line, g) {
      // REPL: evaluate one line; expression results are echoed
      const lines = [line];
      if (!this.globals) { this.globals = this.makeGlobals(['']); this.stack = [new Frame('<module>', this.globals, null)]; }
      let ast;
      try { ast = new Parser(tokenize(line, '<stdin>'), lines).parseModule(); }
      catch (e) { if (e instanceof PySyntaxError) { this.printSyntaxError(e, '<stdin>', lines); return 1; } throw e; }
      const frame = this.stack[0];
      try {
        for (const st of ast.body) {
          const stmts = Array.isArray(st) ? st : [st];
          for (const s of stmts) { if (s.type === 'Expr') { const v = await this.evalNode(s.value, frame); if (v !== null && v !== undefined) this.io.write(repr(v) + '\n'); } else await this.execStmt(s, frame); }
        }
        return 0;
      } catch (e) { return this.handleTopError(e, '<stdin>', lines); }
    }
    handleTopError(e, filename, lines) {
      if (e instanceof PyExit) { if (typeof e.code === 'string') this.io.write(e.code + '\n'); return typeof e.code === 'number' ? e.code : (e.code == null ? 0 : 1); }
      if (e instanceof PyError) { this.printTraceback(e, filename, lines); return 1; }
      if (e && e.name === 'Interrupt') { this.io.write('\nKeyboardInterrupt\n'); return 130; }
      if (e instanceof RangeError) { this.io.write(`Traceback (most recent call last):\n  File "${filename}", line ${this.stack.length ? this.stack[this.stack.length - 1].line : 1}, in <module>\nRecursionError: maximum recursion depth exceeded\n`); return 1; }
      throw e;
    }
    printSyntaxError(e, filename, lines) {
      const text = (e.text != null ? e.text : lines[e.line - 1]) || '';
      const stripped = text.replace(/^\s+/, ''); const lead = text.length - stripped.length;
      const col = Math.max(0, (e.col || 0) - lead);
      const caret = e.pyType === 'IndentationError' ? '' : `    ${' '.repeat(col)}${'^'.repeat(Math.max(1, e.span || 1))}\n`;
      this.io.write(`  File "${filename}", line ${e.line}\n    ${stripped}\n${caret}${e.pyType}: ${e.pyMsg}\n`);
    }
    printTraceback(e, filename, lines) {
      let out = 'Traceback (most recent call last):\n';
      for (const f of (e.frames || this.stack)) { const l = lines[f.line - 1] || ''; out += `  File "${filename}", line ${f.line}, in ${f.name}\n    ${l.trim()}\n`; }
      out += `${e.pyType}: ${e.pyMsg}\n`;
      this.io.write(out);
    }

    // ---- statements ----
    async execBlock(stmts, frame) { for (const s of stmts) { if (Array.isArray(s)) { for (const x of s) await this.execStmt(x, frame); } else await this.execStmt(s, frame); } }
    async execStmt(s, frame) {
      if (++this.steps > MAX_STEPS) throw new PyError('RuntimeError', 'this program ran too long (infinite loop?) and was stopped');
      if (this.io.checkInterrupt && (this.steps & 1023) === 0) this.io.checkInterrupt();
      frame.line = s.line || frame.line;
      switch (s.type) {
        case 'Expr': await this.evalNode(s.value, frame); return;
        case 'Assign': { const v = await this.evalNode(s.value, frame); for (const t of s.targets) await this.assign(t, v, frame); return; }
        case 'AugAssign': { const cur = await this.evalNode(s.target, frame); const r = await this.evalNode(s.value, frame); const v = this.binop(s.op, cur, r, s); await this.assign(s.target, v, frame); return; }
        case 'If': { if (truthy(await this.evalNode(s.test, frame))) await this.execBlock(s.body, frame); else if (s.orelse) await this.execBlock(s.orelse, frame); return; }
        case 'While': { let broke = false; while (truthy(await this.evalNode(s.test, frame))) { try { await this.execBlock(s.body, frame); } catch (e) { if (e instanceof BreakSignal) { broke = true; break; } if (e instanceof ContinueSignal) continue; throw e; } } if (!broke && s.orelse) await this.execBlock(s.orelse, frame); return; }
        case 'For': { const it = iterate(await this.evalNode(s.iter, frame)); for (const x of [...it]) { await this.assign(s.target, x, frame); try { await this.execBlock(s.body, frame); } catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; } } return; }
        case 'Def': { const defaults = []; for (const d of s.defaults) defaults.push(d === undefined ? undefined : await this.evalNode(d, frame)); frame.vars.set(s.name, new PyFunction(s.name, s.params, defaults, s.body, frame)); return; }
        case 'Return': throw new ReturnSignal(s.value ? await this.evalNode(s.value, frame) : null);
        case 'Pass': return;
        case 'Break': throw new BreakSignal();
        case 'Continue': throw new ContinueSignal();
        case 'Import': { for (const n of s.names) frame.vars.set(n.alias, this.importModule(n.name)); return; }
        case 'FromImport': { const m = this.importModule(s.mod); for (const n of s.names) { if (n.name === '*') { for (const [k, v] of m.attrs) frame.vars.set(k, v); continue; } if (!m.attrs.has(n.name)) throw new PyError('ImportError', `cannot import name '${n.name}' from '${s.mod}'`); frame.vars.set(n.alias, m.attrs.get(n.name)); } return; }
        case 'Global': { for (const n of s.names) frame.globalsDecl.add(n); return; }
        case 'Try': {
          try { await this.execBlock(s.body, frame); if (s.orelse) await this.execBlock(s.orelse, frame); }
          catch (e) {
            if (!(e instanceof PyError)) throw e;
            let handled = false;
            for (const h of s.handlers) {
              let match = !h.typeName;
              if (!match) { const names = h.typeName.type === 'Tuple' ? h.typeName.elts.map(x => x.id) : [h.typeName.id || '']; match = names.some(n => n === 'Exception' || n === 'BaseException' || n === e.pyType || (n === 'OSError' && /Error$/.test(e.pyType) && /File|IsADirectory|Permission/.test(e.pyType)) || (n === 'ValueError' && e.pyType === 'UnicodeDecodeError') || (n === 'LookupError' && /IndexError|KeyError/.test(e.pyType))); }
              if (match) { if (h.asName) frame.vars.set(h.asName, e); handled = true; await this.execBlock(h.body, frame); break; }
            }
            if (!handled) throw e;
          } finally { if (s.finalbody) await this.execBlock(s.finalbody, frame); }
          return;
        }
        case 'Raise': { if (!s.exc) throw new PyError('RuntimeError', 'No active exception to reraise'); const v = await this.evalNode(s.exc, frame); if (v instanceof PyError) throw v; throw new PyError(typeof v === 'string' ? 'Exception' : 'Exception', str(v)); }
        case 'Assert': { if (!truthy(await this.evalNode(s.test, frame))) throw new PyError('AssertionError', s.msg ? str(await this.evalNode(s.msg, frame)) : ''); return; }
        case 'Del': { const t = s.target; if (t.type === 'Name') frame.vars.delete(t.id); else if (t.type === 'Subscript') { const c = await this.evalNode(t.value, frame); const k = await this.evalNode(t.index, frame); if (Array.isArray(c)) c.splice(k < 0 ? c.length + k : k, 1); else if (c instanceof Map) c.delete(k); } return; }
        default: throw new PyError('SystemError', 'unknown statement ' + s.type);
      }
    }
    lookup(name, frame) {
      let f = frame;
      if (frame.globalsDecl.has(name)) f = this.stack[0];
      for (; f; f = f.parent) if (f.vars.has(name)) return f.vars.get(name);
      if (this.globals && this.globals.has(name)) return this.globals.get(name);
      throw new PyError('NameError', `name '${name}' is not defined`);
    }
    async assign(t, v, frame) {
      if (t.type === 'Name') { (frame.globalsDecl.has(t.id) ? this.stack[0] : frame).vars.set(t.id, v); return; }
      if (t.type === 'Tuple' || t.type === 'List') { const items = iterate(v); if (items.length !== t.elts.length) throw new PyError('ValueError', items.length > t.elts.length ? `too many values to unpack (expected ${t.elts.length})` : `not enough values to unpack (expected ${t.elts.length}, got ${items.length})`); for (let i = 0; i < t.elts.length; i++) await this.assign(t.elts[i], items[i], frame); return; }
      if (t.type === 'Subscript') { const c = await this.evalNode(t.value, frame); const k = await this.evalNode(t.index, frame); if (Array.isArray(c)) { if (c instanceof PyTuple) throw new PyError('TypeError', "'tuple' object does not support item assignment"); const i = k < 0 ? c.length + k : k; if (i < 0 || i >= c.length) throw new PyError('IndexError', 'list assignment index out of range'); c[i] = v; return; } if (c instanceof Map) { c.set(this.normKey(c, k), v); return; } if (typeof c === 'string') throw new PyError('TypeError', "'str' object does not support item assignment"); throw new PyError('TypeError', `'${typeName(c)}' object does not support item assignment`); }
      if (t.type === 'Attribute') { const o = await this.evalNode(t.value, frame); if (o instanceof PyModule) { o.attrs.set(t.attr, v); return; } throw new PyError('AttributeError', `'${typeName(o)}' object has no attribute '${t.attr}'`); }
      throw new PyError('SyntaxError', 'cannot assign to expression');
    }
    normKey(map, k) { const hk = hashKey(k); for (const key of map.keys()) if (hashKey(key) === hk) return key; return k; }
    mapGet(map, k) { const hk = hashKey(k); for (const [key, v] of map) if (hashKey(key) === hk) return { found: true, v }; return { found: false }; }

    // ---- expressions ----
    async evalNode(n, frame) {
      switch (n.type) {
        case 'Constant': return n.value;
        case 'FString': return this.fstring(n.value, frame);
        case 'Name': return this.lookup(n.id, frame);
        case 'List': { const o = []; for (const e of n.elts) o.push(await this.evalNode(e, frame)); return o; }
        case 'Tuple': { const o = new PyTuple(); for (const e of n.elts) o.push(await this.evalNode(e, frame)); return o; }
        case 'Set': { const o = new Set(); for (const e of n.elts) o.add(await this.evalNode(e, frame)); return o; }
        case 'Dict': { const m = new Map(); for (let i = 0; i < n.keys.length; i++) m.set(await this.evalNode(n.keys[i], frame), await this.evalNode(n.values[i], frame)); return m; }
        case 'BoolOp': { const l = await this.evalNode(n.left, frame); if (n.op === 'and') return truthy(l) ? await this.evalNode(n.right, frame) : l; return truthy(l) ? l : await this.evalNode(n.right, frame); }
        case 'UnaryOp': { const v = await this.evalNode(n.operand, frame); if (n.op === 'not') return !truthy(v); if (n.op === '-') { if (typeof v !== 'number' && typeof v !== 'boolean') throw new PyError('TypeError', `bad operand type for unary -: '${typeName(v)}'`); return -v; } if (n.op === '+') return +v; if (n.op === '~') return ~toInt(v); }
        case 'BinOp': return this.binop(n.op, await this.evalNode(n.left, frame), await this.evalNode(n.right, frame), n);
        case 'Compare': { let l = await this.evalNode(n.left, frame); for (let i = 0; i < n.ops.length; i++) { const r = await this.evalNode(n.rights[i], frame); if (!this.compare(n.ops[i], l, r)) return false; l = r; } return true; }
        case 'IfExp': return truthy(await this.evalNode(n.test, frame)) ? this.evalNode(n.body, frame) : this.evalNode(n.orelse, frame);
        case 'Call': {
          const f = await this.evalNode(n.func, frame);
          const args = []; for (const a of n.args) { if (a.type === 'Starred') args.push(...iterate(await this.evalNode(a.value, frame))); else args.push(await this.evalNode(a, frame)); }
          const kw = new Map(); for (const k of n.kwargs) kw.set(k.name, await this.evalNode(k.value, frame));
          if (!(f instanceof PyFunction) && !(f instanceof PyBuiltin)) throw new PyError('TypeError', `'${typeName(f)}' object is not callable`);
          return this.call(f, args, kw, n);
        }
        case 'Attribute': return this.getAttr(await this.evalNode(n.value, frame), n.attr);
        case 'Subscript': { const c = await this.evalNode(n.value, frame); const k = await this.evalNode(n.index, frame); return this.subscript(c, k); }
        case 'Slice': { const c = await this.evalNode(n.value, frame); const lo = n.lo ? await this.evalNode(n.lo, frame) : null; const hi = n.hi ? await this.evalNode(n.hi, frame) : null; const step = n.step ? await this.evalNode(n.step, frame) : 1; return this.slice(c, lo, hi, step); }
        case 'Comp': {
          const out = [];
          const rec = async (gi, fr) => { if (gi === n.gens.length) { out.push(await this.evalNode(n.elt, fr)); return; } const g = n.gens[gi]; for (const x of [...iterate(await this.evalNode(g.iter, fr))]) { await this.assign(g.target, x, fr); let ok = true; for (const c of g.ifs) if (!truthy(await this.evalNode(c, fr))) { ok = false; break; } if (ok) await rec(gi + 1, fr); } };
          const fr = new Frame(frame.name, new Map(), frame); fr.line = frame.line;
          await rec(0, fr); return out;
        }
        default: throw new PyError('SystemError', 'unknown expression ' + n.type);
      }
    }
    async call(f, args, kw, node) {
      if (f instanceof PyBuiltin) { try { return await f.fn(args, kw); } catch (e) { if (e instanceof PyError && !e.frames) e.frames = this.stack.map(x => ({ name: x.name, line: x.line })); throw e; } }
      const fr = new Frame(f.name, new Map(), f.closure);
      if (args.length > f.params.length) throw new PyError('TypeError', `${f.name}() takes ${f.params.length} positional argument${f.params.length === 1 ? '' : 's'} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
      for (let i = 0; i < f.params.length; i++) {
        let v;
        if (i < args.length) v = args[i]; else if (kw.has(f.params[i])) v = kw.get(f.params[i]); else if (f.defaults[i] !== undefined) v = f.defaults[i];
        else { const missing = f.params.slice(i).filter((p, j) => f.defaults[i + j] === undefined && !kw.has(p)); throw new PyError('TypeError', `${f.name}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${missing.map(m => "'" + m + "'").join(' and ')}`); }
        fr.vars.set(f.params[i], v);
      }
      for (const k of kw.keys()) if (!f.params.includes(k)) throw new PyError('TypeError', `${f.name}() got an unexpected keyword argument '${k}'`);
      if (this.stack.length > 900) throw new PyError('RecursionError', 'maximum recursion depth exceeded');
      this.stack.push(fr);
      try { await this.execBlock(f.body, fr); return null; }
      catch (e) { if (e instanceof ReturnSignal) return e.v; if (e instanceof PyError && !e.frames) e.frames = this.stack.map(x => ({ name: x.name, line: x.line })); throw e; }
      finally { this.stack.pop(); }
    }
    binop(op, a, b, node) {
      const ta = typeName(a), tb = typeName(b);
      const numA = typeof a === 'number' || typeof a === 'boolean', numB = typeof b === 'number' || typeof b === 'boolean';
      if (op === '+') { if (numA && numB) return Number(a) + Number(b); if (typeof a === 'string' && typeof b === 'string') return a + b; if (Array.isArray(a) && Array.isArray(b)) { const o = a instanceof PyTuple ? PyTuple.from(a) : a.slice(); o.push(...b); return o; } if (a instanceof PyBytes && b instanceof PyBytes) return new PyBytes(a.s + b.s); if (typeof a === 'string') throw new PyError('TypeError', `can only concatenate str (not "${tb}") to str`); if (Array.isArray(a)) throw new PyError('TypeError', `can only concatenate list (not "${tb}") to list`); throw new PyError('TypeError', `unsupported operand type(s) for +: '${ta}' and '${tb}'`); }
      if (op === '*') { if (numA && numB) return Number(a) * Number(b); if (typeof a === 'string' && numB) return a.repeat(Math.max(0, toInt(b))); if (numA && typeof b === 'string') return b.repeat(Math.max(0, toInt(a))); if (Array.isArray(a) && numB) { const o = []; for (let i = 0; i < toInt(b); i++) o.push(...a); return o; } if (typeof a === 'string' && typeof b === 'string') throw new PyError('TypeError', "can't multiply sequence by non-int of type 'str'"); throw new PyError('TypeError', `unsupported operand type(s) for *: '${ta}' and '${tb}'`); }
      if (!numA || !numB) { if (op === '%' && typeof a === 'string') return fmtPercent(a, b); throw new PyError('TypeError', `unsupported operand type(s) for ${op}: '${ta}' and '${tb}'`); }
      a = Number(a); b = Number(b);
      switch (op) {
        case '-': return a - b;
        case '/': if (b === 0) throw new PyError('ZeroDivisionError', 'division by zero'); return a / b;
        case '//': if (b === 0) throw new PyError('ZeroDivisionError', 'integer division or modulo by zero'); return Math.floor(a / b);
        case '%': return pyMod(a, b);
        case '**': return Math.pow(a, b);
        case '^': return (toInt(a) ^ toInt(b)) >>> 0 > 0x7fffffff ? (toInt(a) ^ toInt(b)) >>> 0 : (toInt(a) ^ toInt(b));
        case '&': return toInt(a) & toInt(b);
        case '|': return toInt(a) | toInt(b);
        case '<<': return toInt(a) * Math.pow(2, toInt(b));
        case '>>': return Math.floor(toInt(a) / Math.pow(2, toInt(b)));
      }
      throw new PyError('SystemError', 'bad op ' + op);
    }
    compare(op, a, b) {
      switch (op) {
        case '==': return pyEq(a, b); case '!=': return !pyEq(a, b);
        case 'is': return a === b || (a === null && b === null); case 'is not': return !(a === b);
        case 'in': return this.contains(b, a); case 'not in': return !this.contains(b, a);
      }
      const ok = (typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean') || (typeof a === 'string' && typeof b === 'string') || (Array.isArray(a) && Array.isArray(b));
      if (!ok) throw new PyError('TypeError', `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
      if (Array.isArray(a)) { a = JSON.stringify(a); b = JSON.stringify(b); }
      switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; }
    }
    contains(c, x) { if (typeof c === 'string') { if (typeof x !== 'string') throw new PyError('TypeError', `'in <string>' requires string as left operand, not ${typeName(x)}`); return c.includes(x); } if (Array.isArray(c)) return c.some(e => pyEq(e, x)); if (c instanceof Map) return this.mapGet(c, x).found; if (c instanceof Set) return [...c].some(e => pyEq(e, x)); if (c instanceof PyBytes) return typeof x === 'number' ? c.s.includes(String.fromCharCode(x)) : c.s.includes(x.s); if (c instanceof PyRange) return c.toArray().includes(x); throw new PyError('TypeError', `argument of type '${typeName(c)}' is not iterable`); }
    subscript(c, k) {
      if (typeof c === 'string' || Array.isArray(c) || c instanceof PyBytes) {
        const seq = typeof c === 'string' ? Array.from(c) : c instanceof PyBytes ? c.s.split('').map(ch => ch.charCodeAt(0)) : c;
        if (typeof k !== 'number' && typeof k !== 'boolean') throw new PyError('TypeError', `${typeName(c)} indices must be integers or slices, not ${typeName(k)}`);
        const i = k < 0 ? seq.length + k : k; if (i < 0 || i >= seq.length || !Number.isInteger(i)) throw new PyError('IndexError', `${typeName(c)} index out of range`);
        return seq[i];
      }
      if (c instanceof Map) { const r = this.mapGet(c, k); if (!r.found) throw new PyError('KeyError', repr(k)); return r.v; }
      if (c instanceof PyRange) return c.toArray()[k];
      throw new PyError('TypeError', `'${typeName(c)}' object is not subscriptable`);
    }
    slice(c, lo, hi, step) {
      if (!(typeof c === 'string' || Array.isArray(c) || c instanceof PyBytes)) throw new PyError('TypeError', `'${typeName(c)}' object is not subscriptable`);
      const seq = typeof c === 'string' ? Array.from(c) : c instanceof PyBytes ? c.s.split('') : c; const n = seq.length; step = step == null ? 1 : step;
      if (step === 0) throw new PyError('ValueError', 'slice step cannot be zero');
      let out = [];
      if (step > 0) { let a = lo == null ? 0 : lo < 0 ? Math.max(0, n + lo) : Math.min(lo, n); let b = hi == null ? n : hi < 0 ? Math.max(0, n + hi) : Math.min(hi, n); for (let i = a; i < b; i += step) out.push(seq[i]); }
      else { let a = lo == null ? n - 1 : lo < 0 ? n + lo : Math.min(lo, n - 1); let b = hi == null ? -1 : hi < 0 ? n + hi : hi; for (let i = a; i > b; i += step) out.push(seq[i]); }
      if (typeof c === 'string') return out.join(''); if (c instanceof PyBytes) return new PyBytes(out.join('')); return c instanceof PyTuple ? PyTuple.from(out) : out;
    }
    getAttr(o, name) {
      const self = this;
      const B = (n, fn) => new PyBuiltin(n, fn);
      if (o instanceof PyModule) { if (!o.attrs.has(name)) throw new PyError('AttributeError', `module '${o.name}' has no attribute '${name}'`); return o.attrs.get(name); }
      if (typeof o === 'string') {
        const s = o;
        switch (name) {
          case 'join': return B('join', async ([it]) => { const parts = iterate(it); for (const p of parts) if (typeof p !== 'string') throw new PyError('TypeError', `sequence item ${parts.indexOf(p)}: expected str instance, ${typeName(p)} found`); return parts.join(s); });
          case 'upper': return B('upper', async () => s.toUpperCase()); case 'lower': return B('lower', async () => s.toLowerCase());
          case 'strip': return B('strip', async ([ch]) => ch ? s.replace(new RegExp('^[' + ch.replace(/[\]\\^-]/g, '\\$&') + ']+|[' + ch.replace(/[\]\\^-]/g, '\\$&') + ']+$', 'g'), '') : s.trim());
          case 'lstrip': return B('lstrip', async () => s.replace(/^\s+/, '')); case 'rstrip': return B('rstrip', async () => s.replace(/\s+$/, ''));
          case 'split': return B('split', async ([sep, max]) => sep == null ? s.split(/\s+/).filter(Boolean) : (max != null ? (() => { const parts = s.split(sep); return parts.length > max + 1 ? parts.slice(0, max).concat(parts.slice(max).join(sep)) : parts; })() : s.split(sep)));
          case 'splitlines': return B('splitlines', async () => s.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === '')));
          case 'replace': return B('replace', async ([a, b]) => s.split(a).join(b));
          case 'startswith': return B('startswith', async ([p]) => Array.isArray(p) ? p.some(x => s.startsWith(x)) : s.startsWith(p));
          case 'endswith': return B('endswith', async ([p]) => Array.isArray(p) ? p.some(x => s.endsWith(x)) : s.endsWith(p));
          case 'find': return B('find', async ([p]) => s.indexOf(p)); case 'index': return B('index', async ([p]) => { const i = s.indexOf(p); if (i < 0) throw new PyError('ValueError', 'substring not found'); return i; });
          case 'count': return B('count', async ([p]) => p === '' ? s.length + 1 : s.split(p).length - 1);
          case 'encode': return B('encode', async () => new PyBytes(strToBytes(s)));
          case 'format': return B('format', async (args, kw) => { let i = 0; return s.replace(/\{(\w*)(?::([^}]*))?\}/g, (m, k, spec) => { const v = k === '' ? args[i++] : /^\d+$/.test(k) ? args[Number(k)] : kw.get(k); return self.formatSpec(v, spec || ''); }); });
          case 'isdigit': return B('isdigit', async () => /^\d+$/.test(s)); case 'isalpha': return B('isalpha', async () => /^[A-Za-z]+$/.test(s)); case 'isalnum': return B('isalnum', async () => /^[A-Za-z0-9]+$/.test(s));
          case 'isupper': return B('isupper', async () => s === s.toUpperCase() && s !== s.toLowerCase()); case 'islower': return B('islower', async () => s === s.toLowerCase() && s !== s.toUpperCase());
          case 'isspace': return B('isspace', async () => /^\s+$/.test(s));
          case 'title': return B('title', async () => s.replace(/\b\w/g, c => c.toUpperCase())); case 'capitalize': return B('capitalize', async () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()); case 'swapcase': return B('swapcase', async () => s.split('').map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(''));
          case 'zfill': return B('zfill', async ([n]) => s.padStart(n, '0')); case 'center': return B('center', async ([n, f]) => { const t = n - s.length; if (t <= 0) return s; const l = Math.floor(t / 2); return (f || ' ').repeat(l) + s + (f || ' ').repeat(t - l); });
          case 'ljust': return B('ljust', async ([n, f]) => s.padEnd(n, f || ' ')); case 'rjust': return B('rjust', async ([n, f]) => s.padStart(n, f || ' '));
        }
        throw new PyError('AttributeError', `'str' object has no attribute '${name}'`);
      }
      if (o instanceof PyBytes) {
        switch (name) { case 'decode': return B('decode', async () => o.decode()); case 'hex': return B('hex', async () => o.s.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')); case 'strip': return B('strip', async () => new PyBytes(o.s.trim())); case 'split': return B('split', async ([sep]) => o.s.split(sep ? sep.s : /\s+/).map(x => new PyBytes(x))); case 'startswith': return B('startswith', async ([p]) => o.s.startsWith(p.s)); case 'replace': return B('replace', async ([a, b]) => new PyBytes(o.s.split(a.s).join(b.s))); }
        throw new PyError('AttributeError', `'bytes' object has no attribute '${name}'`);
      }
      if (Array.isArray(o)) {
        if (o instanceof PyTuple) { if (name === 'index') return B('index', async ([x]) => o.findIndex(e => pyEq(e, x))); if (name === 'count') return B('count', async ([x]) => o.filter(e => pyEq(e, x)).length); throw new PyError('AttributeError', `'tuple' object has no attribute '${name}'`); }
        switch (name) {
          case 'append': return B('append', async ([x]) => { o.push(x); return null; }); case 'pop': return B('pop', async ([i]) => { if (!o.length) throw new PyError('IndexError', 'pop from empty list'); if (i === undefined) return o.pop(); const k = i < 0 ? o.length + i : i; if (k < 0 || k >= o.length) throw new PyError('IndexError', 'pop index out of range'); return o.splice(k, 1)[0]; });
          case 'insert': return B('insert', async ([i, x]) => { o.splice(i, 0, x); return null; }); case 'extend': return B('extend', async ([it]) => { o.push(...iterate(it)); return null; });
          case 'remove': return B('remove', async ([x]) => { const i = o.findIndex(e => pyEq(e, x)); if (i < 0) throw new PyError('ValueError', 'list.remove(x): x not in list'); o.splice(i, 1); return null; });
          case 'index': return B('index', async ([x]) => { const i = o.findIndex(e => pyEq(e, x)); if (i < 0) throw new PyError('ValueError', `${repr(x)} is not in list`); return i; });
          case 'count': return B('count', async ([x]) => o.filter(e => pyEq(e, x)).length); case 'reverse': return B('reverse', async () => { o.reverse(); return null; });
          case 'sort': return B('sort', async (a, kw) => { o.sort((x, y) => (typeof x === 'string' ? (x < y ? -1 : x > y ? 1 : 0) : x - y)); if (kw.get('reverse')) o.reverse(); return null; });
          case 'copy': return B('copy', async () => o.slice()); case 'clear': return B('clear', async () => { o.length = 0; return null; });
        }
        throw new PyError('AttributeError', `'list' object has no attribute '${name}'`);
      }
      if (o instanceof Map) {
        switch (name) { case 'keys': return B('keys', async () => [...o.keys()]); case 'values': return B('values', async () => [...o.values()]); case 'items': return B('items', async () => [...o.entries()].map(e => PyTuple.from(e))); case 'get': return B('get', async ([k, d]) => { const r = self.mapGet(o, k); return r.found ? r.v : (d === undefined ? null : d); }); case 'pop': return B('pop', async ([k, d]) => { const r = self.mapGet(o, k); if (!r.found) { if (d === undefined) throw new PyError('KeyError', repr(k)); return d; } o.delete(self.normKey(o, k)); return r.v; }); case 'update': return B('update', async ([m]) => { for (const [k, v] of m) o.set(self.normKey(o, k), v); return null; }); case 'setdefault': return B('setdefault', async ([k, d]) => { const r = self.mapGet(o, k); if (r.found) return r.v; o.set(k, d === undefined ? null : d); return d === undefined ? null : d; }); case 'copy': return B('copy', async () => new Map(o)); case 'clear': return B('clear', async () => { o.clear(); return null; }); }
        throw new PyError('AttributeError', `'dict' object has no attribute '${name}'`);
      }
      if (o instanceof Set) { switch (name) { case 'add': return B('add', async ([x]) => { if (![...o].some(e => pyEq(e, x))) o.add(x); return null; }); case 'remove': return B('remove', async ([x]) => { o.delete(x); return null; }); case 'discard': return B('discard', async ([x]) => { o.delete(x); return null; }); } throw new PyError('AttributeError', `'set' object has no attribute '${name}'`); }
      if (o instanceof PyFile) {
        switch (name) {
          case 'read': return B('read', async () => { if (o.closed) throw new PyError('ValueError', 'I/O operation on closed file.'); return o.data; });
          case 'readline': return B('readline', async () => { const i = (o.pos = o.pos || 0); const d = typeof o.data === 'string' ? o.data : o.data.s; const j = d.indexOf('\n', i); const line = j < 0 ? d.slice(i) : d.slice(i, j + 1); o.pos = j < 0 ? d.length : j + 1; return typeof o.data === 'string' ? line : new PyBytes(line); });
          case 'readlines': return B('readlines', async () => iterate(o));
          case 'write': return B('write', async ([s]) => { o.data += str(s); self.files.write(o.name, o.data); return str(s).length; });
          case 'close': return B('close', async () => { o.closed = true; return null; });
          case 'name': return o.name; case 'mode': return o.mode; case 'closed': return o.closed;
          case '__enter__': return B('__enter__', async () => o); case '__exit__': return B('__exit__', async () => null);
        }
        throw new PyError('AttributeError', `'_io.TextIOWrapper' object has no attribute '${name}'`);
      }
      if (o instanceof PyError) { if (name === 'args') return PyTuple.from([o.pyMsg]); throw new PyError('AttributeError', `'${o.pyType}' object has no attribute '${name}'`); }
      if (typeof o === 'number') { if (name === 'real') return o; if (name === 'bit_length') return B('bit_length', async () => Math.abs(toInt(o)).toString(2).length); if (name === 'to_bytes') return B('to_bytes', async ([n, order]) => { let v = toInt(o); const bytes = []; for (let i = 0; i < n; i++) { bytes.push(String.fromCharCode(v & 255)); v = Math.floor(v / 256); } if (order !== 'little') bytes.reverse(); return new PyBytes(bytes.join('')); }); }
      if (o instanceof PyFunction || o instanceof PyBuiltin) { if (name === '__name__') return o.name; }
      throw new PyError('AttributeError', `'${typeName(o)}' object has no attribute '${name}'`);
    }
    formatSpec(v, spec) {
      if (!spec) return str(v);
      const m = spec.match(/^(?:(.)?([<>^]))?([+ ]?)(#?)(0?)(\d*)(?:\.(\d+))?([bdoxXsfe%])?$/);
      if (!m) return str(v);
      let [, fill, align, , alt, zero, width, prec, type] = m; let s;
      if (type === 'x' || type === 'X') { s = toInt(v).toString(16); if (type === 'X') s = s.toUpperCase(); if (alt) s = '0x' + s; }
      else if (type === 'b') s = toInt(v).toString(2); else if (type === 'o') s = toInt(v).toString(8); else if (type === 'd') s = String(toInt(v));
      else if (type === 'f') s = Number(v).toFixed(prec ? parseInt(prec, 10) : 6); else if (type === '%') s = (Number(v) * 100).toFixed(prec ? parseInt(prec, 10) : 6) + '%';
      else s = prec && typeof v === 'string' ? v.slice(0, parseInt(prec, 10)) : str(v);
      const w = width ? parseInt(width, 10) : 0; fill = fill || (zero ? '0' : ' '); align = align || (typeof v === 'number' ? '>' : '<');
      if (s.length < w) { if (align === '<') s = s.padEnd(w, fill); else if (align === '>') s = s.padStart(w, fill); else { const t = w - s.length; const l = Math.floor(t / 2); s = fill.repeat(l) + s + fill.repeat(t - l); } }
      return s;
    }
    async fstring(src, frame) {
      let out = ''; let i = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '{') { if (src[i + 1] === '{') { out += '{'; i += 2; continue; } let depth = 1, j = i + 1, inner = ''; while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } inner += src[j]; j++; } i = j + 1;
          let spec = ''; let conv = null; const specIdx = inner.lastIndexOf(':'); let expr = inner;
          if (specIdx > 0 && !/[(\[]/.test(inner.slice(specIdx))) { spec = inner.slice(specIdx + 1); expr = inner.slice(0, specIdx); }
          const cm = expr.match(/!([rsa])$/); if (cm) { conv = cm[1]; expr = expr.slice(0, -2); }
          let selfDoc = false; if (expr.trim().endsWith('=')) { selfDoc = true; expr = expr.trim().slice(0, -1); }
          const ast = new Parser(tokenize(expr.trim(), '<fstring>'), [expr]).parseModule();
          const node = ast.body[0]; const v = await this.evalNode(node.value || node, frame);
          out += (selfDoc ? expr + '=' : '') + (conv === 'r' ? repr(v) : this.formatSpec(v, spec));
          continue; }
        if (ch === '}' && src[i + 1] === '}') { out += '}'; i += 2; continue; }
        out += ch; i++;
      }
      return out;
    }
  }
  function hashKeySafe(v) { try { let h = 0; const s = hashKey(v); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; } catch (e) { return 0; } }
  function modPow(b, e, m) { let r = 1; b = b % m; while (e > 0) { if (e & 1) r = (r * b) % m; e = Math.floor(e / 2); b = (b * b) % m; } return r; }

  /* ---------------- bridge for shell.js: python3 command ---------------- */
  // files adapter: {read(name) -> {data, bin, isDir} | null, write(name, data), cwd(), listdir(p)}
  async function runPython3(ctx, args) {
    const util = global.CTFShell && global.CTFShell.util;
    const s = ctx.session;
    const files = {
      read: name => { const p = util.joinPath(s.cwd, name); const n = s.fs.get(p); if (!n) return null; if (n.t === 'd') return { isDir: true }; return { data: n.data, bin: !!n.bin }; },
      write: (name, data) => s.fs.write(util.joinPath(s.cwd, name), data),
      cwd: () => s.cwd,
      listdir: p => { const n = s.fs.get(util.joinPath(s.cwd, p)); return n && n.t === 'd' ? Object.keys(n.c).sort() : []; },
    };
    const io = { write: t => ctx.out(t), readLine: o => ctx.readLine(o), files, checkInterrupt: ctx.io && ctx.io.checkInterrupt ? () => ctx.io.checkInterrupt() : null, stdinText: ctx.hasStdin ? (ctx.stdin || '') : null };
    if (ctx.hasStdin) io.readLine = async () => { const t = io.stdinText || ''; if (!t) return null; const i = t.indexOf('\n'); io.stdinText = i < 0 ? '' : t.slice(i + 1); return i < 0 ? t : t.slice(0, i); };
    const interp = new Interpreter(io);
    const rest = args.slice(); let code = null, script = null; const opts = [];
    while (rest.length && rest[0].startsWith('-') && rest[0] !== '-') { const o = rest.shift(); if (o === '-c') { code = rest.shift(); if (code == null) { ctx.err('Argument expected for the -c option\n'); return 2; } break; } if (o === '-m') { ctx.err(`/usr/bin/python3: No module named ${rest[0] || ''}\n`); return 1; } if (o === '-V' || o === '--version') { ctx.out('Python 3.11.2\n'); return 0; } if (o === '-h' || o === '--help') { ctx.out('usage: python3 [option] ... [-c cmd | file | -] [arg] ...\nOptions:\n-c cmd : program passed in as string\n-V     : print the Python version number\nfile   : program read from script file\n'); return 0; } if (o === '-u' || o === '-B' || o === '-i') continue; ctx.err(`Unknown option: ${o}\n`); return 2; }
    if (code != null) return interp.runSource(code, '<string>', ['-c'].concat(rest));
    if (!rest.length) {
      if (ctx.isPipe && ctx.hasStdin) return interp.runSource(ctx.stdin || '', '<stdin>', ['']);
      ctx.out('Python 3.11.2 (main, club practice machine) [GCC 12.2.0] on linux\nType "help", "exit()" or Ctrl+D to leave. One line at a time on this machine.\n');
      for (;;) {
        let line;
        try { line = await ctx.readLine({ prompt: '>>> ' }); } catch (e) { if (e && e.name === 'Interrupt') { ctx.out('\nKeyboardInterrupt\n'); continue; } throw e; }
        if (line == null) { ctx.out('\n'); return 0; }
        if (!line.trim()) continue;
        if (/^(exit|quit)\(\)\s*$/.test(line.trim())) return 0;
        if (/:\s*$/.test(line.trim())) { // a block: collect until blank line
          let block = line + '\n'; for (;;) { const more = await ctx.readLine({ prompt: '... ' }); if (more == null || !more.trim()) break; block += more + '\n'; } await interp.runInteractiveLine(block); continue;
        }
        try { await interp.runInteractiveLine(line); } catch (e) { if (e instanceof PyExit) return typeof e.code === 'number' ? e.code : 0; throw e; }
      }
    }
    script = rest.shift();
    const f = files.read(script);
    if (!f) { ctx.err(`python3: can't open file '${util.joinPath(s.cwd, script)}': [Errno 2] No such file or directory\n`); return 2; }
    if (f.isDir) { ctx.err(`python3: can't open file '${script}': [Errno 21] Is a directory\n`); return 2; }
    return interp.runSource(f.bin ? bytesToStr(f.data) : f.data, script, [script].concat(rest));
  }

  global.MiniPy = { Interpreter, tokenize, Parser, PyError, PySyntaxError, PyExit, runPython3, repr, str };
  if (global.CTFShell) global.CTFShell.COMMANDS.python3 = (ctx, args) => runPython3(ctx, args);
})(typeof window !== 'undefined' ? window : globalThis);
