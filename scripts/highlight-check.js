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
    'var ext = i32 extends i64;',
    'var t = (a > b) ? a : b;',
    'x += 1;',
    'while x > 0 { x--; }',
    'comptime func add(a: i32, b: i32): i32 { return a + b; }',
    'comptime var SUM = add(1, 2);',
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

  // ---- cxs 汇编语法冒烟测试 ----
  const registryCxs = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s) => new vsco.OnigScanner(s), createOnigString: (s) => new vsco.OnigString(s) }),
    loadGrammar: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'cxs.tmLanguage.json'), 'utf8')),
  });
  const cxsGrammar = await registryCxs.loadGrammar('source.cxs');
  if (!cxsGrammar) { console.error('FAIL: cxs grammar not loaded'); process.exit(1); }

  const cxsSample = [
    '; hello.cxs — 最小可运行示例',
    '_start:',
    '    push_func_type',
    '    push "void"',
    '    func_type_return',
    '    seal 64',
    '    load_type 64',
    '    push_array',
    '    push "i32"',
    '    define_bound 3',
    '    seal 65',
    '    load_type 65',
    '    .byte 0x0a',
    '    push_function [main]',
    '    bind_func 64',
    '    set_func_name "main"',
    '    push_undefined',
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

  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
