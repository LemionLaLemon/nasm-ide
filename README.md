# NASM IDE

Language Server Protocol-based editing for NASM-style x86/x86_64 assembly:
completions, hover docs, goto-definition, diagnostics, **cross-file `extern`
support**, link-library awareness, and build tasks.

Fork origins and credit: this project builds on the excellent
[vscode-nasm-intellisense](https://github.com/Alec269/vscode-nasm-intellisense)
by Nomayer Alam (Alec269, MIT), which itself builds on ideas from
[asm-lsp](https://github.com/bergercookie/asm-lsp) (Berger Cookie, BSD-2).
The server, grammar, and database were substantially extended here
(full instruction/register coverage, doc comments, workspace index).
See `LICENSE.md` (MIT).

## Features

- **Autocomplete** for ~190 instructions (with unabbreviated names, e.g.
  `jae` — *Jump if Above or Equal*), 136 registers, directives, file-local
  labels/`equ` constants, and `global` symbols from other workspace files.
- **Hover docs** for instructions, registers, directives, and your own
  functions, including doc comments (see below).
- **Diagnostics** by running your local `nasm` (as-you-type with debounce,
  or on save), **multiple-definition errors** across files, and
  **unresolved-`extern` warnings** that know about your link libraries.
- **Doc comments** above labels and `equ` constants:
  ```nasm
  ; Adds two numbers.
  ; @param eax first operand
  ; @param ebx second operand
  ; @return eax the sum
  addition:
  ```
  Supported tags: `@param name [size] desc`, `@return [size] [name] desc`
  (sizes: `byte word dword qword tword oword yword zword`, `N bytes`).
  `;`, `;;`, `; @`, and `;---@` prefixes all work.
- **Link libraries**: `NASM IDE: Pick Link Libraries` searches your system
  (`ldconfig` + compiler search dirs) for `-l` flags and saves them to the
  workspace. The server reads their exports (`nm -D`) so `extern printf`
  with `-lc` configured stays quiet while typos get flagged.
- **Build tasks** (`nasm-ide: build/run/clean`) assembling `build.sources`
  with `nasm` and linking with `ld`/`gcc` plus your libraries. Errors land
  in the Problems panel (and Error Lens).

## Configuration

All settings live under `nasmIde` (see package.json for the full schema):
`nasmPath`, `arch`, `diagnostics.enable/mode/debounceMs/unresolvedExterns`,
`libraries`, `build.linker/sources/objDir/output/extraLdFlags`.

## Commands

- `NASM IDE: Restart Language Server`
- `NASM IDE: Show Server Status`
- `NASM IDE: Toggle Diagnostics`
- `NASM IDE: Pick Link Libraries`

## Developing

```sh
npm install
cd server && npm install && cd ..
npm run compile   # tsc client + server
npm test          # unit + LSP integration tests (needs nasm + gcc tooling)
npm run package   # builds nasm-ide-*.vsix (needs network for vsce)
```

## Publishing

```sh
npx -y @vscode/vsce publish            # Visual Studio Marketplace
npx -y ovsx publish nasm-ide-*.vsix    # Open VSX (for code-oss / VSCodium)
```

You need a publisher account + Personal Access Token for each registry
(see CONTRIBUTING-level docs online for `vsce login` / `ovsx publish -p`).
