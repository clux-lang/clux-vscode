// clux / cxs 语法高亮自检（vscode-textmate + vscode-oniguruma）。
//
// 运行：node scripts/highlight-check.js   （或 npm run check:highlight）
//
// 检查分四层：
//   1. 样例文件：examples/demo.cx 与 examples/demo.cxs **逐行 tokenize**，断言
//      关键 scope 齐全（这两个文件同时是"高亮展示"，必须能被当前编译器编译/
//      汇编——见 README）。
//   2. 关键字 / 助记符全表：编译器的每个关键字、字节码的每条助记符都必须被着色。
//      这是最主要的**防漂移**手段：语言加了新关键字而 grammar 没跟上，这里直接红。
//   3. 与编译器源码交叉核对（可选）：能找到 clux 仓库时，直接解析
//      `src/parser/lexer.c` 的 g_keywords 与 `src/vm/bcode_asm_defs.c` 的
//      BCODE_ASM_TABLE，要求本脚本的表（以及 grammar）与编译器**逐项一致**；
//      找不到时退回脚本内置的清单（并打印提示）。
//      路径：$CLUX_SRC 或同级目录 ../clux。
//   4. 语法交互：字符串里的 `//`、`'<a>` 与字符字面量、`->` / `...` / `::`、
//      聚合体内成员着色、struct 结束后不泄漏等。
'use strict';

const fs = require('fs');
const path = require('path');
const vsctm = require('vscode-textmate');
const vsco = require('vscode-oniguruma');

const ROOT = path.join(__dirname, '..');
const failures = [];
const passes = [];

function ok(msg) {
  passes.push(msg);
}
function fail(msg) {
  failures.push(msg);
}

/* ================================================================ */
/* 1. 引擎与 grammar                                                 */
/* ================================================================ */

async function loadRegistry() {
  await vsco.loadWASM(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'))
  );
  const onigLib = Promise.resolve({
    createOnigScanner: (s) => new vsco.OnigScanner(s),
    createOnigString: (s) => new vsco.OnigString(s),
  });
  return (grammarFile, scopeName) =>
    new vsctm.Registry({
      onigLib,
      loadGrammar: async () =>
        JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', grammarFile), 'utf8')),
    }).loadGrammar(scopeName);
}

/* 逐行 tokenize 整段文本，返回 [{ line, text, scopes }]（跳过纯空白）。 */
function tokenize(grammar, text) {
  const out = [];
  let state = null;
  for (const line of text.split(/\r?\n/)) {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    for (const t of r.tokens) {
      const chunk = line.slice(t.startIndex, t.endIndex);
      if (/^\s*$/.test(chunk)) continue;
      out.push({ line, text: chunk, scopes: t.scopes.filter((s) => s !== 'source.clux' && s !== 'source.cxs') });
    }
  }
  return out;
}

function tokenizeLine(grammar, line) {
  return tokenize(grammar, line);
}

/* ================================================================ */
/* 2. 编译器事实（可选交叉核对）                                      */
/* ================================================================ */

function findCompilerSrc() {
  const candidates = [
    process.env.CLUX_SRC,
    path.resolve(ROOT, '..', 'clux'),
    path.resolve(ROOT, '..', '..', 'clux'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'src', 'parser', 'lexer.c')) &&
      fs.existsSync(path.join(dir, 'src', 'vm', 'bcode_asm_defs.c'))
    ) {
      return dir;
    }
  }
  return null;
}

function readCompilerFacts(dir) {
  const lexer = fs.readFileSync(path.join(dir, 'src', 'parser', 'lexer.c'), 'utf8');
  const kwBlock = lexer.match(/g_keywords\[\]\s*=\s*\{([\s\S]*?)\};/);
  const keywords = kwBlock ? [...kwBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  const defs = fs.readFileSync(path.join(dir, 'src', 'vm', 'bcode_asm_defs.c'), 'utf8');
  const mnemonics = [...defs.matchAll(/\{\s*"([A-Z0-9_]+)"/g)].map((m) => m[1].toLowerCase());

  return {
    keywords: [...new Set(keywords)].sort(),
    mnemonics: [...new Set(mnemonics)].sort(),
  };
}

/* ================================================================ */
/* 3. 关键字表（与 src/parser/lexer.c 的 g_keywords 一一对应）        */
/* ================================================================ */
// 每个关键字：一行能命中的上下文 + 期望的 scope。改动语言时**同步这里**——
// 交叉核对会要求本表与编译器关键字表完全一致。
const KW = {
  alignof: ['var n = alignof(i32);', 'keyword.operator.clux'],
  as: ['var x = y as i64;', 'keyword.operator.clux'],
  bool: ['var b: bool = true;', 'storage.type.primitive.clux'],
  break: ['while (true) { break; }', 'keyword.control.clux'],
  clone: ['var c = clone(r);', 'keyword.operator.clux'],
  cfunc: ['cfunc cb(data: ref *u8, n: usize): i32 { return 0; }', 'storage.modifier.clux'],
  comptime: ['comptime var N = 1;', 'storage.modifier.clux'],
  const: ['var c: const i32 = 1;', 'storage.modifier.clux'],
  continue: ['while (true) { continue; }', 'keyword.control.clux'],
  cunion: ['cunion Bits { i: i32; f: f32; }', 'storage.type.clux'],
  default: ['switch (x) { (1) -> { } default -> { } }', 'keyword.control.clux'],
  defer: ['defer { cleanup(); }', 'keyword.control.clux'],
  do: ['do { x += 1; } while (x < 3);', 'keyword.control.clux'],
  else: ['if (x) { } else { }', 'keyword.control.clux'],
  enum: ['enum Color: i32 { Red = 1 }', 'storage.type.clux'],
  export: ['export func f(): void { }', 'keyword.module.clux'],
  extends: ['var e = i32 extends i64;', 'keyword.operator.clux'],
  extern: ['extern lib "*" as libc;', 'storage.modifier.clux'],
  f32: ['var v: f32 = 1.5f32;', 'storage.type.primitive.clux'],
  f64: ['var v: f64 = 1.5f64;', 'storage.type.primitive.clux'],
  false: ['var b = false;', 'constant.language.clux'],
  fatal: ['var p: fatal *i32 = q;', 'storage.modifier.clux'],
  for: ['for (var i: usize = 0u64; i < 3u64; i = i + 1u64) { }', 'keyword.control.clux'],
  foreach: ['foreach (var e of arr) { }', 'keyword.control.clux'],
  from: ['import math from "./math";', 'keyword.module.clux'],
  func: ['func main(): i32 { return 0; }', 'storage.type.clux'],
  i8: ['var v: i8 = 1i8;', 'storage.type.primitive.clux'],
  i16: ['var v: i16 = 1i16;', 'storage.type.primitive.clux'],
  i32: ['var v: i32 = 1i32;', 'storage.type.primitive.clux'],
  i64: ['var v: i64 = 1i64;', 'storage.type.primitive.clux'],
  if: ['if (x > 0) { }', 'keyword.control.clux'],
  import: ['import math from "./math";', 'keyword.module.clux'],
  is: ['if (s is radius) { }', 'keyword.operator.clux'],
  len: ['var n = len(arr);', 'keyword.operator.clux'],
  lib: ['extern lib "*" as libc;', 'keyword.module.clux'],
  make: ['var s = make(i32, 3, 1, 2, 3);', 'keyword.operator.clux'],
  move: ['var m = move(p);', 'keyword.operator.clux'],
  new: ['var p = new i32{ 1 };', 'keyword.operator.clux'],
  nil: ['var q: ?i32 = nil;', 'constant.language.clux'],
  of: ['foreach (var e of arr) { }', 'keyword.control.clux'],
  opaque: ['var h: opaque = nil;', 'storage.type.primitive.clux'],
  own: ['var p: own *i32 = new i32{ 1 };', 'storage.modifier.clux'],
  ref: ['var r: ref *i32 = p.&;', 'storage.modifier.clux'],
  return: ['return 0;', 'keyword.control.clux'],
  share: ['var s: share *i32 = nil;', 'storage.modifier.clux'],
  sizeof: ['var n = sizeof(i32);', 'keyword.operator.clux'],
  str: ['var s: str = "x";', 'storage.type.primitive.clux'],
  struct: ['struct Point { x: i32; }', 'storage.type.clux'],
  switch: ['switch (x) { (1) -> { } }', 'keyword.control.clux'],
  true: ['var b = true;', 'constant.language.clux'],
  type: ['type Vec = [3]i32;', 'storage.type.clux'],
  typeof: ['type T = typeof(x);', 'keyword.operator.clux'],
  u8: ['var v: u8 = 1u8;', 'storage.type.primitive.clux'],
  u16: ['var v: u16 = 1u16;', 'storage.type.primitive.clux'],
  u32: ['var v: u32 = 1u32;', 'storage.type.primitive.clux'],
  u64: ['var v: u64 = 1u64;', 'storage.type.primitive.clux'],
  undefined: ['var x: i32 = undefined;', 'constant.language.clux'],
  union: ['union Shape { r: f32; }', 'storage.type.clux'],
  usize: ['var n: usize = 0u64;', 'storage.type.primitive.clux'],
  var: ['var x = 0;', 'storage.type.clux'],
  void: ['func f(): void { }', 'storage.type.primitive.clux'],
  volatile: ['var c: volatile i32 = 1;', 'storage.modifier.clux'],
  weak: ['var w: weak *i32 = nil;', 'storage.modifier.clux'],
  while: ['while (x > 0) { }', 'keyword.control.clux'],
};

/* ================================================================ */
/* 4. 助记符表（与 src/vm/bcode_asm_defs.c 的 BCODE_ASM_TABLE 一致）  */
/* ================================================================ */
const MNEMONICS = `
add add_embed addr and append_elem bind_func bnot bxor call cast construct
create_const create_volatile data define define_bound define_field define_type
dispose div enum_variant eq extern_call extern_load extern_store field_get
field_set free free_recursive func_type_param func_type_return func_type_vararg
ge get_member gt halt import index_get index_set is_tag jmp jnz jz le length load
load_attr load_function load_type lt make make_enum make_function mark_unique
member_call mod mul ne neg new not opt_is_none or pop pop_scope ptr_get ptr_set
push push_array push_bool push_const push_cunion push_enum push_f32 push_f64
push_func_type push_function push_i16 push_i32 push_i64 push_i8 push_opt
push_opt_none push_ptr push_scope push_slice push_string push_struct push_tuple
push_u16 push_u32 push_u64 push_u8 push_undefined push_usize push_union push_value
push_volatile ret seal set_closure set_field_ownership set_func_captures
set_func_name set_ownership set_type set_type_name shl shr slice store
store_attr store_nil store_reinit sub take_slot union_member unwrap
`
  .trim()
  .split(/\s+/)
  .sort();

/* ================================================================ */
/* 5. 断言辅助                                                       */
/* ================================================================ */

/* 断言某行里 text 的 token 带 scope（scope 为前缀匹配，如 'keyword.control'）。 */
function expectScoped(grammar, line, text, scopePrefix, label) {
  const tokens = tokenizeLine(grammar, line);
  const hit = tokens.find(
    (t) => t.text === text && t.scopes.some((s) => s === scopePrefix || s.startsWith(scopePrefix + '.'))
  );
  if (hit) {
    ok(`${label || text} → ${scopePrefix}`);
    return true;
  }
  const actual = tokens.filter((t) => t.text === text).map((t) => t.scopes.join(' '));
  fail(
    `${label || text}: 期望 ${JSON.stringify(text)} 着 ${scopePrefix}，实际 ${JSON.stringify(actual)}（行：${line}）`
  );
  return false;
}

/* 断言某行里 text 的 token **没有** scope（用于"不是这个颜色"的负例）。 */
function expectUnscoped(grammar, line, text, label) {
  const tokens = tokenizeLine(grammar, line);
  const hits = tokens.filter((t) => t.text === text);
  if (hits.length === 0) {
    ok(`${label || text}: 未被当作独立 token`);
    return true;
  }
  fail(`${label || text}: 不该有 scope，实际 ${JSON.stringify(hits.map((t) => t.scopes.join(' ')))}`);
  return false;
}

/* 断言整行**没有**某个 scope（用于"字符串里的注释符号不得变成注释"这类整体判定）。 */
function expectNoScope(grammar, line, scope, label) {
  const tokens = tokenizeLine(grammar, line);
  const hits = tokens.filter((t) => t.scopes.includes(scope));
  if (hits.length === 0) {
    ok(`${label}: 无 ${scope}`);
    return true;
  }
  fail(`${label}: 不该出现 ${scope}，实际 ${JSON.stringify(hits.map((t) => t.text))}（行：${line}）`);
  return false;
}

/* 断言整行**含**某个 scope 的 token（begin/end 规则会把字面量拆成首尾标点 + 内容）。 */
function expectSomeScope(grammar, line, scope, label) {
  const tokens = tokenizeLine(grammar, line);
  if (tokens.some((t) => t.scopes.includes(scope))) {
    ok(`${label} → ${scope}`);
    return true;
  }
  fail(`${label}: 行内没有任何 ${scope} 的 token（${JSON.stringify(tokens.map((t) => [t.text, t.scopes]) )}）`);
  return false;
}

/* ================================================================ */
/* 6. 主流程                                                         */
/* ================================================================ */

(async () => {
  const load = await loadRegistry();
  const clux = await load('clux.tmLanguage.json', 'source.clux');
  const cxs = await load('cxs.tmLanguage.json', 'source.cxs');
  if (!clux) throw new Error('clux grammar 加载失败');
  if (!cxs) throw new Error('cxs grammar 加载失败');
  console.log('grammar：syntaxes/clux.tmLanguage.json → source.clux，syntaxes/cxs.tmLanguage.json → source.cxs');
  console.log(`关键字表：${Object.keys(KW).length} 项；助记符表：${MNEMONICS.length} 项`);

  /* ---------- 6.1 样例文件：关键 scope 齐全 ---------- */
  const demoCx = fs.readFileSync(path.join(ROOT, 'examples', 'demo.cx'), 'utf8');
  const demoCxs = fs.readFileSync(path.join(ROOT, 'examples', 'demo.cxs'), 'utf8');
  const cxTokens = tokenize(clux, demoCx);
  const cxSeen = new Set(cxTokens.flatMap((t) => t.scopes));

  const expectedCxScopes = [
    'comment.line.double-slash.clux',
    'comment.block.clux',
    'entity.name.function.clux',
    'entity.name.type.clux',
    'storage.type.clux',
    'storage.type.primitive.clux',
    'storage.modifier.clux',
    'keyword.control.clux',
    'keyword.operator.clux',
    'keyword.operator.vararg.clux',
    'keyword.operator.scope.clux',
    'keyword.module.clux',
    'constant.language.clux',
    'constant.numeric.hex.clux',
    'constant.numeric.binary.clux',
    'constant.numeric.octal.clux',
    'constant.numeric.float.clux',
    'constant.numeric.decimal.clux',
    'constant.character.escape.clux',
    'string.quoted.double.clux',
    'string.quoted.single.clux',
    'variable.other.clux',
    'variable.other.member.clux',
    'variable.other.enummember.clux',
    'variable.parameter.clux',
    'variable.other.module.clux',
    'variable.other.global.clux',
    'keyword.other.discard.clux',
    'punctuation.section.braces.clux',
    'punctuation.section.parens.clux',
    'punctuation.section.brackets.clux',
    'punctuation.separator.clux',
    'punctuation.accessor.clux',
  ];
  for (const s of expectedCxScopes) {
    if (cxSeen.has(s)) ok(`demo.cx 含 ${s}`);
    else fail(`demo.cx 缺少 scope ${s}`);
  }

  const cxsTokens = tokenize(cxs, demoCxs);
  const cxsSeen = new Set(cxsTokens.flatMap((t) => t.scopes));
  const expectedCxsScopes = [
    'comment.line.semicolon.cxs',
    'entity.name.label.cxs',
    'variable.other.label.cxs',
    'keyword.mnemonic.cxs',
    'keyword.directive.cxs',
    'string.quoted.double.cxs',
    'constant.character.escape.cxs',
    'constant.numeric.decimal.cxs',
  ];
  for (const s of expectedCxsScopes) {
    if (cxsSeen.has(s)) ok(`demo.cxs 含 ${s}`);
    else fail(`demo.cxs 缺少 scope ${s}`);
  }

  /* ---------- 6.2 关键字全表 ---------- */
  for (const [kw, [line, scope]] of Object.entries(KW)) {
    expectScoped(clux, line, kw, scope, `关键字 ${kw}`);
  }

  /* ---------- 6.3 助记符全表 ---------- */
  for (const mn of MNEMONICS) {
    expectScoped(cxs, `    ${mn}`, mn, 'keyword.mnemonic.cxs', `助记符 ${mn}`);
  }
  expectScoped(cxs, '    .byte 10', '.byte', 'keyword.directive.cxs', '指令 .byte');

  /* ---------- 6.4 与编译器源码交叉核对 ---------- */
  const compilerSrc = findCompilerSrc();
  if (!compilerSrc) {
    console.log(
      'NOTE: 未找到 clux 编译器源码（可用 CLUX_SRC=<clux 仓库> 指定），跳过交叉核对，仅用脚本内置清单。'
    );
  } else {
    const facts = readCompilerFacts(compilerSrc);
    console.log(
      `交叉核对源：${compilerSrc} → ${facts.keywords.length} 个关键字 / ${facts.mnemonics.length} 条助记符`
    );
    ok(`交叉核对源：${compilerSrc}（${facts.keywords.length} 关键字 / ${facts.mnemonics.length} 助记符）`);

    const missingKw = facts.keywords.filter((k) => !(k in KW));
    const extraKw = Object.keys(KW).filter((k) => !facts.keywords.includes(k));
    if (missingKw.length) fail(`编译器有、脚本关键字表没有：${missingKw.join(', ')}（请补 KW 表并给 grammar 加规则）`);
    else ok('关键字表覆盖编译器的全部关键字');
    if (extraKw.length) fail(`脚本关键字表有、编译器没有：${extraKw.join(', ')}（语言已删除该关键字？）`);

    const missingMn = facts.mnemonics.filter((m) => !MNEMONICS.includes(m));
    const extraMn = MNEMONICS.filter((m) => !facts.mnemonics.includes(m));
    if (missingMn.length) fail(`编译器有、脚本助记符表没有：${missingMn.join(', ')}`);
    else ok('助记符表覆盖 BCODE_ASM_TABLE 的全部指令');
    if (extraMn.length) fail(`脚本助记符表有、编译器没有：${extraMn.join(', ')}（指令已删除？）`);
  }

  /* ---------- 6.5 语法交互与负例 ---------- */
  // 字符串里的 `//` 与 `/*` 不得被当成注释（begin/end 规则把字面量拆成首尾标点 + 内容）
  expectSomeScope(clux, 'var s = "http://example/x";', 'string.quoted.double.clux', '字符串中的 //');
  expectNoScope(clux, 'var s = "http://example/x";', 'comment.line.double-slash.clux', '字符串中的 // 不当注释');
  expectSomeScope(clux, 'var s = "/* not a comment */";', 'string.quoted.double.clux', '字符串中的 /*');
  expectNoScope(clux, 'var s = "/* not a comment */";', 'comment.block.clux', '字符串中的 /* 不当注释');
  // 作用域标注 vs 字符字面量
  expectScoped(clux, "var t: '<a> ref *i32 = r;", "'<a>", 'keyword.operator.scope.clux', "作用域标注 '<a>");
  expectSomeScope(clux, "var ch = 'z';", 'string.quoted.single.clux', '字符字面量');
  expectNoScope(clux, "var ch = 'z';", 'keyword.operator.scope.clux', "字符字面量不当作用域标注");
  // 运算符
  expectScoped(clux, 'var ft: func(i32)->i32 = f;', '->', 'keyword.operator.clux', '函数类型 ->');
  expectScoped(clux, 'switch (x) { (1) -> { } }', '->', 'keyword.operator.clux', 'switch 分支 ->');
  expectScoped(clux, 'extern cfunc libc::printf(f: str, ...): void;', '...', 'keyword.operator.vararg.clux', 'FFI 变参 ...');
  expectScoped(clux, 'var c: Color = Color::Red;', '::', 'keyword.operator.clux', ':: 限定名');
  expectScoped(clux, 'var r: ref *i32 = v.&;', '&', 'keyword.operator.clux', '后置 .&');
  expectScoped(clux, 'var v = r.*;', '*', 'keyword.operator.clux', '后置 .*');
  expectScoped(clux, 'var x = q.!;', '!', 'keyword.operator.clux', '后置 .!');
  expectScoped(clux, 'var x = q.?;', '?', 'keyword.operator.clux', '后置 .?');
  expectScoped(clux, 'var b = x ? 1 : 2;', '?', 'keyword.operator.clux', '三元 ?');
  expectScoped(clux, 'var n = 123usize;', '123usize', 'constant.numeric.decimal.clux', 'usize 字面量后缀');
  expectScoped(clux, 'var n = 0xFFu8;', '0xFFu8', 'constant.numeric.hex.clux', 'hex + 后缀');
  expectScoped(clux, 'var n = 3.14e10f64;', '3.14e10f64', 'constant.numeric.float.clux', '浮点 + 后缀');
  expectScoped(clux, 'var e = i32 extends i64;', 'extends', 'keyword.operator.clux', 'extends');
  // 聚合体成员
  expectScoped(clux, 'struct Point { x: i32; }', 'x', 'variable.other.member.clux', 'struct 字段');
  expectScoped(clux, 'enum Color: i32 { Red = 1 }', 'Red', 'variable.other.enummember.clux', 'enum variant');
  expectScoped(clux, 'struct S { func f(self: ref *S): i32 { return 0; } }', 'self', 'variable.parameter.clux', '方法参数 self');
  expectScoped(clux, 'struct S { var total: i32 = 0; }', 'total', 'variable.other.clux', 'struct 静态属性');
  expectScoped(clux, 'var p = .Point{ .x = 1 };', 'Point', 'entity.name.type.clux', '.T{} 构造类型');
  expectScoped(clux, 'var p = new Point{ .x = 1 };', 'Point', 'entity.name.type.clux', 'new T{} 类型');
  expectScoped(clux, 'var p = .Point{ .x = 1 };', 'x', 'variable.other.member.clux', '构造字段 .x');
  expectScoped(clux, 'var m = h.bump();', 'bump', 'variable.other.member.clux', '方法调用成员');
  // foreach 头部三段
  expectScoped(clux, 'foreach (var e of arr) { }', 'foreach', 'keyword.control.clux', 'foreach 关键字');
  expectScoped(clux, 'foreach (var e of arr) { }', 'e', 'variable.other.clux', 'foreach 迭代变量');
  expectScoped(clux, 'foreach (e of arr) { }', 'of', 'keyword.control.clux', 'foreach 的 of');
  // comptime 前缀 + 三个编译期运算符
  expectScoped(clux, 'comptime if (N == 3) { }', 'comptime', 'storage.modifier.clux', 'comptime if');
  // 丢弃标记与函数字面量兜底
  expectScoped(clux, '_ = x;', '_', 'keyword.other.discard.clux', '丢弃标记 _');
  expectScoped(clux, 'var f = func |x| (v: i32): i32 { return v; };', 'func', 'storage.type.clux', '闭包 func 兜底');
  expectScoped(clux, 'var f = func |base| inc(n: i32): i32 { return n; };', 'inc', 'entity.name.function.clux', '带捕获的具名闭包');
  // struct 结束后不泄漏（后续 func 仍是普通函数声明）
  const leakCheck = tokenize(clux, 'struct S { x: i32; }\nfunc main(): i32 { return 0; }\n');
  const mainTok = leakCheck.filter((t) => t.text === 'main');
  if (mainTok.length === 1 && mainTok[0].scopes.includes('entity.name.function.clux')) {
    ok('struct 结束后作用域不泄漏');
  } else {
    fail(`struct 结束后作用域泄漏：main → ${JSON.stringify(mainTok.map((t) => t.scopes))}`);
  }
  // 注释里的关键字不参与着色
  expectUnscoped(clux, '// func struct return', 'func', '注释里的 func');
  // 汇编：字符串里的 ';' 不是注释起始（行注释规则只认行内 ';'）
  expectSomeScope(cxs, '    push_string "a; b"', 'string.quoted.double.cxs', 'asm 字符串含 ;');
  expectNoScope(cxs, '    push_string "a; b"', 'comment.line.semicolon.cxs', 'asm 字符串中的 ; 不当注释');

  /* ---------- 6.6 真实语料（clux 的 examples/*.cx 全量） ---------- */
  // 目的不是逐 scope 断言，而是抓"结构性跑偏"：某个 { 没配对、某条规则吃掉后续代码，
  // 都会让声明名的着色消失。所以只查两条强不变量：
  //   - `func` 关键字后面紧跟的标识符必须是 entity.name.function；
  //   - `struct|enum|union|cunion|type` 后面的标识符必须是 entity.name.type。
  if (compilerSrc) {
    const examplesDir = path.join(compilerSrc, 'examples');
    const files = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.cx')) files.push(p);
      }
    })(examplesDir);

    let declChecked = 0;
    const declProblems = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const toks = tokenize(clux, text);
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const isFunc = t.text === 'func' && t.scopes.includes('storage.type.clux');
        const isTypeDecl =
          ['struct', 'enum', 'union', 'cunion', 'type'].includes(t.text) &&
          t.scopes.includes('storage.type.clux');
        if (!isFunc && !isTypeDecl) continue;
        // 下一个 token 必须是名字（`func (` 匿名 / `func |cap|` 捕获列表 跳过；
        // `type` 后面跟的是别名，`struct` 后面跟的是类型名，都要求 entity.name.type）
        const next = toks[i + 1];
        if (!next) continue;
        if (isFunc && (next.text === '(' || next.text === '|' || next.text === '[')) continue;
        const want = isFunc ? 'entity.name.function.clux' : 'entity.name.type.clux';
        const isIdent = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(next.text);
        if (!isIdent) continue;
        declChecked++;
        if (!next.scopes.includes(want)) {
          declProblems.push(
            `${path.relative(compilerSrc, file)}: ${JSON.stringify(t.text + ' ' + next.text)} 期望 ${want}，实际 ${JSON.stringify(next.scopes)}`
          );
        }
      }
    }
    if (declProblems.length === 0) {
      console.log(`真实语料：${files.length} 个 .cx / ${declChecked} 处声明名，着色一致`);
      ok(`真实语料 ${files.length} 个 .cx 的声明名着色一致（${declChecked} 处声明）`);
    } else {
      for (const p of declProblems.slice(0, 15)) fail(`语料着色异常 → ${p}`);
      if (declProblems.length > 15) fail(`…还有 ${declProblems.length - 15} 处同类问题`);
    }
  }

  /* ---------- 7. 汇总 ---------- */
  console.log(`\n通过 ${passes.length} 项。`);
  if (failures.length) {
    console.error(`\n失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('OK: clux / cxs 语法高亮自检全部通过。');
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
