# NASM IDE

Language support for **64/32-bit x86 NASM assembly** in VS Code and
code-oss (Open VSX): IntelliSense, hover docs, cross-file `extern`
navigation, library-aware diagnostics, doc comments, and one-command builds.

Fork origins and credit: built on
[vscode-nasm-intellisense](https://github.com/Alec269/vscode-nasm-intellisense)
by Nomayer Alam (Alec269, MIT), with ideas from
[asm-lsp](https://github.com/bergercookie/asm-lsp) (Berger Cookie, BSD-2).
The server, grammar, instruction database, and all features below were
substantially extended here. License: MIT, see `LICENSE.md`.

<!-- Screenshots go here (docs/img/*.png):
     1. completion + hover for instructions
     2. doc-comment hover on a user function
     3. cross-file extern hover + multiple-definition error
     4. Pick Link Libraries quickpick
-->

## How it works

```
┌──────────────┐  LSP (stdio/IPC)  ┌─────────────────────────────┐
│  VS Code /   │◄─────────────────►│  nasm-ide language server   │
│  code-oss    │                   │  hover · complete · goto-def │
│  + Error Lens│  diagnostics      │  nasm per-file check        │
└──────────────┘                   │  workspace extern index     │
                                   │  nm-based library index     │
                                   └─────────────────────────────┘
```

- **Per-file checks**: on every edit (debounced, configurable) or on save,
  the server assembles a temp copy with your local `nasm -f elf64/elf32`
  and turns `file:line: error/warning` output into editor diagnostics, so
  Error Lens shows them inline.
- **Workspace index**: all `*.asm/*.nasm/*.inc` under the opened folder are
  scanned for `global` symbols (with their doc comments). `extern` uses in
  any file resolve to the defining file for hover, completion, and
  go-to-definition. A `global` defined in two files is a link error, so it
  is surfaced early as `multiple definition of \`foo\``.
- **Library awareness**: each `-l` flag in `nasmIde.libraries` is resolved
  to its `.so` (`ldconfig` + compiler search dirs) and its exports are read
  with `nm -D`. An `extern` that is neither defined in the workspace nor
  exported by a configured library warns as *unresolved* — while `extern
  printf` with `-lc` stays quiet.
- **Build tasks**: the `nasm-ide` task provider assembles `build.sources`
  with debug info and links with `ld` (or `gcc`) plus your libraries and
  extra flags. `nasm` output uses the `$gcc` problem matcher, so build
  errors also land in Problems / Error Lens.

## Features

- ~190 instructions with unabbreviated names (`jae` — *Jump if Above or
  Equal*), 136 registers, SSE/AVX scalar float, core x87 FPU, directives.
- 57 common libc functions (`printf`, `malloc`, `memcpy`, …) with C
  signatures and link hints (`-lc` vs `-lm`).
- Doc comments above labels and `equ` constants (see below).
- As-you-type (debounced) or on-save diagnostics.
- `NASM IDE: Pick Link Libraries` — fuzzy-search every linkable `-l` flag
  on your system, saved to the workspace.

## Doc comments

```nasm
; Adds two numbers.
; @param eax 32 bit signed integer
; @param ebx dword second operand
; @return eax the sum
addition:
```

- Tags: `@param [size] name desc`, `@return [size] [name] desc`.
- Sizes: `byte word dword qword tword oword yword zword`, `N bytes`
  (before or after the name).
- Prefixes: `;`, `;;`, `; @`, `;---@` all work; `;---` separators and blank
  lines end the block; `global`/`extern` lines are transparent to it.
- Shows on hover (at the definition and at every `call`) and in completions.

## Configuration (`nasmIde`)

| Key | Default | What |
| --- | --- | --- |
| `nasmPath` | `"nasm"` | Assembler executable for diagnostics |
| `arch` | `"x86_64"` | `elf64` vs `elf32` diagnostics format |
| `diagnostics.enable` | `true` | Master switch |
| `diagnostics.mode` | `"asYouType"` | Or `"onSave"` |
| `diagnostics.debounceMs` | `400` | As-you-type delay |
| `diagnostics.unresolvedExterns` | `true` | Warn on unknown `extern` |
| `libraries` | `["c"]` | `-l` flags (folder scope, use the picker) |
| `build.linker` | `"ld"` | Or `"gcc"` |
| `build.sources` | `["src/*.asm"]` | Globs relative to the folder |
| `build.objDir` | `"obj"` | Intermediate `.o` dir |
| `build.output` | `"bin/${workspaceFolderBasename}"` | Linked binary |
| `build.extraLdFlags` | `[]` | e.g. `["-dynamic-linker", "/lib64/ld-linux-x86-64.so.2"]` |

## Commands / tasks

- `NASM IDE: Restart Language Server` · `Show Server Status` ·
  `Toggle Diagnostics` · `Pick Link Libraries`
- Tasks: `NASM IDE: build` (default build, `Ctrl+Shift+B`), `run`, `clean`.

## Developing

```sh
npm install && cd server && npm install && cd ..
npm run compile   # tsc client + server
npm test          # unit + LSP integration + headless client tests
npm run package   # nasm-ide-*.vsix
```

## Publishing

```sh
vsce publish                 # Visual Studio Marketplace
ovsx publish nasm-ide-*.vsix # Open VSX (code-oss / VSCodium)
```

Needs a publisher account + tokens (`vsce login`, `ovsx publish -p`).
