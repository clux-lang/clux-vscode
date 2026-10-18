# clux for Visual Studio Code

[clux](https://github.com/AserJoker/clux)（C, but with LUX）的语言支持：

- **语法高亮**：`.cx` 源码与 `.cxs` 字节码汇编各有一套 TextMate grammar；
- **格式化**：调用外部 `clux format -`（stdin → stdout），可用 `clux.binaryPath` 指定可执行文件。

## 高亮覆盖范围

与 **当前编译器**对齐（语言从 M1 长到 M5 + 前脱糖 `foreach`，grammar 逐个跟上）：

| 类别 | 内容 |
|---|---|
| 声明 | `func` / `cfunc` / `extern cfunc` / `extern func` / `extern var` / `extern lib <别名> from "<库名>"` / `var` / `const` / `comptime` / `type` / `struct` / `enum` / `union` / `cunion` / `import` / `export` |
| 类型 | `bool str void opaque` 与全部整数/浮点宽度（含 `usize`）、`?T`、`[N]T`、`[]T`、`*T`、`func(...)->T` |
| 所有权 | `own` / `ref` / `fatal` / `share` / `weak`、`move` / `clone` / `new`、后置 `.&` / `.*` / `.!` / `.?`、作用域标注 `'<a,b>` |
| 控制流 | `if` / `else` / `switch`（`->` 分支）/ `while` / `do` / `for` / **`foreach` … `of`** / `break` / `continue` / `return` / `defer` |
| 编译期 | `comptime var` / `comptime func` / `comptime if`、`sizeof` / `alignof` / `typeof`、`is` / `extends` / `as` |
| 字面量 | 多进制整数 + `i8`…`u64` / `usize` 后缀、浮点 + `f32`/`f64`、`true`/`false`/`nil`/`undefined`、字符与转义 |
| 成员 | 聚合体字段 / enum variant / 方法名 / 形参 / 模块别名 / `::` 限定的 extern 符号 |
| 汇编 | `BCODE_ASM_TABLE` 全 118 条助记符、标签定义与 `[label]` 引用、`.byte`、字符串与十进制操作数 |

## 自检（防漂移）

```sh
npm run check:highlight
```

它用 `vscode-textmate` + `vscode-oniguruma`（与 VSCode 同款引擎）做四层检查：

1. `examples/demo.cx` / `examples/demo.cxs` 逐行 tokenize，断言关键 scope 齐全
   （这两个文件同时必须能被当前 `clux` 编译 / 汇编——见下）；
2. 编译器的**每个关键字**、字节码的**每条助记符**都必须被着色；
3. 若找得到 clux 仓库（`$CLUX_SRC` 或同级 `../clux`），直接解析
   `src/parser/lexer.c` 的 `g_keywords` 与 `src/vm/bcode_asm_defs.c` 的
   `BCODE_ASM_TABLE`，要求脚本内的表与编译器**逐项一致**——语言加/删关键字而
   grammar 没跟上时，这里直接报红（曾漏过 `foreach` / `of` / `type`）；
4. 语法交互：字符串里的 `//` 与 `/*` 不算注释、`'<a>` 不算字符字面量、`->` /
   `...` / `::`、`.&` / `.*` / `.!`、`usize` 后缀、struct 结束后不泄漏等。

样例程序本身也是被验证过的：

```sh
clux run examples/demo.cx                  # 需要 PATH 上的 clux（或直接用构建产物）
clux bc asm examples/demo.cxs -o demo.cxb  # 汇编；再 clux run demo.cxb
```

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `clux.binaryPath` | `clux` | `clux` 可执行文件路径（不在 `PATH` 上时写绝对路径，例如 `D:/projects/clux/build/clux.exe`） |

命令：`clux: Format Document`、`clux: Set Binary Path`。

## 开发

```sh
npm install
npm run compile          # tsc → out/
npm run check:highlight  # 高亮自检
npm run package          # 打包 .vsix（vsce）
```

改语法时改这几处：`syntaxes/*.tmLanguage.json`、`scripts/highlight-check.js`
的关键字/助记符表（交叉核对会强制同步）、`examples/demo.*`（样例同时是回归输入）。
