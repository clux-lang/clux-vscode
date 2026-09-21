// 冒烟测试：用 vscode-textmate 引擎加载 clux grammar，
// 对典型 clux 代码做一次词法着色，断言关键 scope 出现。
// 运行：node scripts/highlight-check.js
'use strict';

const fs = require('fs');
const path = require('path');
const vsctm = require('vscode-textmate');
const vsco = require('vscode-oniguruma');
const wasmBin = vsco.loadWASM;

(async () => {
  await vsco.loadWASM(
    fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
    )
  );
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s) => new vsco.OnigScanner(s), createOnigString: (s) => new vsco.OnigString(s) }),
    loadGrammar: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'clux.tmLanguage.json'), 'utf8')),
  });
  const grammar = await registry.loadGrammar('source.clux');
  if (!grammar) { console.error('FAIL: grammar not loaded'); process.exit(1); }

  const sample = [
    '// 行注释',
    '/* 块注释 */',
    '/* 块注释不嵌套：',
    '   遇到第一个 */ 即结束',
    '   之后按代码处理 */',
    'func fib(n: i32): i32 {',
    '    if n <= 1 { return n; }',
    '    return fib(n - 1) + fib(n - 2);',
    '}',
    'var x: i32 = 0xFFu8;',
    'var y = 3.14e10f64;',
    'var s = "a\\tb\\x41";',
    'var c = \'z\';',
    'var ok = true && !false;',
    'var u = undefined;',
    'var n = nil;',
    'var ext = i32 extends i64;',
    'var t = (a > b) ? a : b;',
    'x += 1;',
    'while x > 0 { x--; }',
    'switch (x) {',
    '    (1, 2)->{ return 1; }',
    '    default->{ return 0; }',
    '}',
    'var ft: func(i32)->i32;',
    'comptime func add(a: i32, b: i32): i32 { return a + b; }',
    'comptime var SUM = add(1, 2);',
    'func |fact| fact(n: i32): i32 { return n * fact(n - 1); }',
    'var g = func |base| add2(x: i32): i32 { return base + x; };',
    'enum Color:i32 { Red = 1, Green = 2, Blue = 3 }',
    'var c: Color = Color::Red;',
  ].join('\n');

  const lines = sample.split('\n');
  const expected = [
    'comment.line.double-slash.clux',
    'comment.block.clux',
    'storage.type.function.clux',
    'entity.name.function.clux',
    'storage.type.primitive.clux',
    'keyword.control.clux',
    'constant.numeric.clux',
    'string.quoted.double.clux',
    'constant.character.escape.clux',
    'string.quoted.single.clux',
    'constant.language.clux',
    'keyword.operator.clux',
    'storage.type.clux',
    'variable.other.clux',
    'storage.modifier.clux',
    'entity.name.type.clux',
  ];

  const found = new Set();
  const seen = new Set();
  let state = null;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    for (const t of r.tokens) {
      for (const s of t.scopes) seen.add(s);
    }
  }
  const missing = expected.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    console.error('MISSING scopes:', missing.join(', '));
    console.error('seen scopes:', [...seen].join('\n'));
    process.exit(1);
  }
  console.log('OK: all', expected.length, 'clux expected scopes produced.');

  // ---- enum 声明 + Color::Red 访问断言 ----
  // enum 关键字 → storage.type.clux；类型名 → entity.name.type.clux；
  // Color::Red 中的 :: → keyword.operator.clux。
  const enumLine = lines.find((l) => l.startsWith('enum Color'));
  const er = grammar.tokenizeLine(enumLine, null);
  const enumKw = er.tokens.filter((t) => t.scopes.includes('storage.type.clux'))
    .map((t) => enumLine.slice(t.startIndex, t.endIndex)).join('');
  const enumName = er.tokens.filter((t) => t.scopes.includes('entity.name.type.clux'))
    .map((t) => enumLine.slice(t.startIndex, t.endIndex)).join('');
  if (enumKw !== 'enum') {
    console.error('FAIL: enum keyword not highlighted as storage.type:', JSON.stringify(enumKw));
    process.exit(1);
  }
  if (enumName !== 'Color') {
    console.error('FAIL: enum type name not highlighted as entity.name.type:', JSON.stringify(enumName));
    process.exit(1);
  }
  const refLine = lines.find((l) => l.includes('Color::Red'));
  const rr = grammar.tokenizeLine(refLine, null);
  const opHits = rr.tokens
    .filter((t) => t.scopes.includes('keyword.operator.clux'))
    .map((t) => refLine.slice(t.startIndex, t.endIndex));
  if (!opHits.includes('::')) {
    console.error('FAIL: :: not highlighted as keyword.operator:', JSON.stringify(opHits));
    process.exit(1);
  }
  console.log('OK: enum declaration + Color::Red assertions passed.');

  // ---- 不嵌套块注释 + 函数类型断言 ----
  // 不嵌套注释：块注释遇第一个 */ 即结束（与 C 一致），其后的内容按代码处理；
  // 函数类型：func( 中的 func 必须着 storage.type.function.clux。
  const midIdx = lines.findIndex((l) => l.startsWith('   遇到第一个'));
  const afterIdx = lines.findIndex((l) => l.startsWith('   之后按代码处理'));
  if (midIdx < 0 || afterIdx < 0) {
    console.error('FAIL: non-nested comment sample lines not found');
    process.exit(1);
  }
  let nState = null;
  const cTokens = []; /* midIdx 行 token 列表（含空白豁免） */
  for (let i = 0; i <= midIdx; i++) {
    const r = grammar.tokenizeLine(lines[i], nState);
    nState = r.ruleStack;
    if (i === midIdx) {
      for (const t of r.tokens) cTokens.push({ line: lines[i], token: t });
    }
  }
  const midLine = lines[midIdx];
  const closeAt = midLine.indexOf('*' + '/'); /* 首个结束标记位置 */
  for (const { line, token: t } of cTokens) {
    const text = line.slice(t.startIndex, t.endIndex);
    if (/^\s*$/.test(text)) continue; /* 空白（含 CRLF 尾随 \r）豁免 */
    const endPunct = t.scopes.includes('punctuation.definition.comment.end.clux');
    if (text === '*' + '/' && endPunct) continue; /* 结束标记本身合法 */
    if (t.endIndex <= closeAt + 2) {
      if (!t.scopes.includes('comment.block.clux')) {
        console.error('FAIL: pre-*/ content not comment.block.clux:', JSON.stringify(t));
        process.exit(1);
      }
    } else if (t.scopes.includes('comment.block.clux')) {
      console.error('FAIL: post-*/ content still comment.block.clux:', JSON.stringify(t));
      process.exit(1);
    }
  }
  const ar = grammar.tokenizeLine(lines[afterIdx], nState);
  for (const t of ar.tokens) {
    const text = lines[afterIdx].slice(t.startIndex, t.endIndex);
    if (/^\s*$/.test(text)) continue;
    if (t.scopes.includes('comment.block.clux')) {
      console.error('FAIL: line after */ still comment.block.clux:', JSON.stringify(t));
      process.exit(1);
    }
  }
  const ftLine = lines.find((l) => l.startsWith('var ft: func('));
  const fr = grammar.tokenizeLine(ftLine, null);
  const ftHits = fr.tokens.filter((t) => t.scopes.includes('storage.type.function.clux'));
  const ftText = ftHits.map((t) => ftLine.slice(t.startIndex, t.endIndex)).join('');
  if (ftText !== 'func') {
    console.error('FAIL: func-type keyword not highlighted as storage.type.function:', JSON.stringify(ftText));
    process.exit(1);
  }
  console.log('OK: non-nested block comment + func-type keyword assertions passed.');

  // ---- 闭包语法 func 关键字断言 ----
  // 捕获列表（func |fact| fact / func |base| add2）不打断 function-declaration：
  // func 必须着 storage.type.function.clux，函数名着 entity.name.function.clux。
  for (const [needle, funcText, nameText] of [
    ['func |fact| fact', 'func', 'fact'],
    ['func |base| add2', 'func', 'add2'],
  ]) {
    const cLine = lines.find((l) => l.includes(needle));
    if (!cLine) {
      console.error('FAIL: closure sample line not found:', needle);
      process.exit(1);
    }
    const cr = grammar.tokenizeLine(cLine, null);
    const cFunc = cr.tokens.filter((t) => t.scopes.includes('storage.type.function.clux'))
      .map((t) => cLine.slice(t.startIndex, t.endIndex)).join('');
    const cName = cr.tokens.filter((t) => t.scopes.includes('entity.name.function.clux'))
      .map((t) => cLine.slice(t.startIndex, t.endIndex)).join('');
    if (cFunc !== funcText) {
      console.error('FAIL: closure func keyword not highlighted as storage.type.function:', JSON.stringify(cFunc));
      process.exit(1);
    }
    if (cName !== nameText) {
      console.error('FAIL: closure function name not highlighted as entity.name.function:', JSON.stringify(cName));
      process.exit(1);
    }
  }
  console.log('OK: closure func keyword + function name assertions passed.');

  // ---- cxs 汇编语法冒烟测试 ----
  const registryCxs = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s) => new vsco.OnigScanner(s), createOnigString: (s) => new vsco.OnigString(s) }),
    loadGrammar: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'cxs.tmLanguage.json'), 'utf8')),
  });
  const cxsGrammar = await registryCxs.loadGrammar('source.cxs');
  if (!cxsGrammar) { console.error('FAIL: cxs grammar not loaded'); process.exit(1); }

  const cxsSample = [
    '; hello.cxs — 最小可运行示例',
    '; hoist 两遍扫描：pass 1 声明（PUSH_FUNC_TYPE / PUSH_ARRAY / PUSH_CONST / PUSH_VOLATILE → DEFINE_TYPE）',
    '_start:',
    '    push_func_type',
    '    define_type 64',
    '    push_array',
    '    define_type 65',
    '    push_const',
    '    define_type 66',
    '    push_volatile',
    '    define_type 67',
    '    ; pass 2 定义（LOAD_TYPE 拉回 → 设字段 → SEAL）',
    '    load_type 64',
    '    push "void"',
    '    func_type_return',
    '    seal',
    '    load_type 65',
    '    push "i32"',
    '    define_bound 3',
    '    seal',
    '    load_type 66',
    '    load_type 2',
    '    set_type',
    '    seal',
    '    load_type 67',
    '    load_type 66',
    '    set_type',
    '    seal',
    '    push_enum',
    '    define_type 68',
    '    load_type 68',
    '    load_type 2',
    '    set_type',
    '    enum_variant "Red" 1',
    '    enum_variant "Green" 2',
    '    seal',
    '    load_type 68',
    '    push_i32 1',
    '    make_enum',
    '    .byte 0x0a',
    '    load_type 64',
    '    push_function [main]',
    '    bind_func 64',
    '    set_func_name "main"',
    '    push_undefined',
    '    set_closure "base"',
    '    define "main"',
    '    halt',
    'main:',
    '    push_scope',
    '    push "printf"',
    '    push_string "hello, clux\\n"',
    '    call 1',
    '    pop',
    '    pop_scope',
    '    push_undefined',
    '    ret',
  ].join('\n');

  const cxsExpected = [
    'comment.line.semicolon.cxs',
    'entity.name.label.cxs',
    'keyword.mnemonic.cxs',
    'keyword.directive.cxs',
    'string.quoted.double.cxs',
    'variable.other.label.cxs',
    'constant.character.escape.cxs',
    'constant.numeric.decimal.cxs',
  ];

  const cxsSeen = new Set();
  let cxsState = null;
  for (const line of cxsSample.split('\n')) {
    const r = cxsGrammar.tokenizeLine(line, cxsState);
    cxsState = r.ruleStack;
    for (const t of r.tokens) {
      for (const s of t.scopes) cxsSeen.add(s);
    }
  }
  const cxsMissing = cxsExpected.filter((s) => !cxsSeen.has(s));
  if (cxsMissing.length > 0) {
    console.error('MISSING cxs scopes:', cxsMissing.join(', '));
    console.error('seen cxs scopes:', [...cxsSeen].join('\n'));
    process.exit(1);
  }
  console.log('OK: all', cxsExpected.length, 'cxs expected scopes produced.');

  // ---- cxs enum 助记符断言 ----
  // PUSH_ENUM / ENUM_VARIANT "Red" 1 / MAKE_ENUM 必须着 keyword.mnemonic.cxs。
  const enumMn = ['push_enum', 'enum_variant', 'make_enum'];
  const cxsTokens = [];
  let eState = null;
  for (const line of cxsSample.split('\n')) {
    const r = cxsGrammar.tokenizeLine(line, eState);
    eState = r.ruleStack;
    for (const t of r.tokens) {
      const text = line.slice(t.startIndex, t.endIndex);
      if (t.scopes.includes('keyword.mnemonic.cxs')) cxsTokens.push(text);
    }
  }
  for (const m of enumMn) {
    if (!cxsTokens.includes(m)) {
      console.error('FAIL: enum mnemonic not highlighted:', m);
      process.exit(1);
    }
  }
  console.log('OK: cxs enum mnemonics (push_enum/enum_variant/make_enum) highlighted.');

  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
