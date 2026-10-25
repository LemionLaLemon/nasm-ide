# 0.3.8

- Fixed syntax highlighting for NASM single-quoted strings containing
  backslashes (for example ASCII art with `\` before the closing quote).
  NASM treats single-quoted strings literally, so `\'` no longer starts an
  unterminated string that colors the rest of the file.
- Added backtick-quoted string highlighting, which does support escapes.
- Added grammar tests for literal single quotes and escaped double quotes.

# 0.3.7

- Fixed pending gdb breakpoints being reported as verified. GDB marks them
  with `addr="<PENDING>"`, so source, function, and instruction breakpoints
  now correctly show as unverified until they resolve.
- When a source breakpoint has no debug line table, the breakpoint message and
  Debug Console now explain that code must be in `section .text` for NASM to
  emit DWARF line information.
- Added an integration test that debugs a two-source program and verifies
  breakpoints in both files.

# 0.3.6

- Register values now show unsigned decimal and printable ASCII inline
  (`rax  0x2a  (42)  '*'`).
- `rsp`/`esp` show `% 16` and an `aligned` marker when the remainder is zero.
- Register editing still works with the annotated display; only the leading
  hex value is sent to gdb.

# 0.3.5

- Added **NASM IDE: Configure Debugging** to create `.vscode/launch.json` and
  `.vscode/tasks.json` automatically. It detects Makefile targets, preserves
  existing configurations and tasks, and falls back to the extension's build
  task when there is no Makefile.
- Documented that `tasks.json` is optional because the extension provides the
  build, run, clean, and make tasks itself.

# 0.3.4

- Variables can now be edited from the Variables view. Double-click a register, a `.data`/`.bss` scalar, an expanded byte row, or a struct field and enter a new value. Registers accept gdb expressions; data accepts numbers, comma-separated elements, quoted strings, or hex byte lists such as `68 69 00`.
- Register and data edits refresh the affected Variables and Memory views immediately.
- Added tests for register editing, scalar/string/buffer writes, struct-field writes, and byte-row writes.

# 0.3.3

- Added a `Data (.data/.bss)` scope to the debugger. Global data labels are shown with their address, type, and current value. Arrays and strings expand into a byte view, and labels such as `Window:` group their local fields (`.rows`, `.cols`, ...).
- Data sizes are read from the NASM source instead of relying on incomplete ELF symbol sizes, so strings, reserved buffers, and macro-sized reservations such as `Map resb MapSize * MapSize` display correctly.

# 0.3.2

- Fixed Stop while the target is running leaving `gdbserver` and the inferior program alive in the terminal. The debugger now kills the inferior before closing gdb, so the next launch starts cleanly instead of hanging behind the old terminal session.

# 0.3.1

- Fixed `could not find task 'NASM IDE: make'` when starting the debugger: the extension now activates for `onTaskType:nasm-ide` (and for dynamic debug configurations), so the build task is available before pre-launch task lookup.
- Makefile detection also accepts `makefile` and `GNUmakefile`, not only `Makefile`.

# 0.3.0

- Added a gdb-based debugger for NASM (`type: "nasm"`), with launch and attach configurations.
- Programs that need a terminal (ncurses, X11, interactive stdin) launch through `gdbserver` in an integrated or external terminal. Lightweight/headless programs can use `"console": "internalConsole"` for direct gdb I/O.
- Source, function, conditional, hit-count, and instruction breakpoints; continue, pause, source/instruction stepping, and step out.
- Scopes for registers, decoded flags (CF/PF/AF/ZF/SF/TF/IF/DF/OF/...), and the 16 qwords at `rsp`.
- Call stack with source lines, evaluate/hover, Debug Console gdb commands, disassembly, and read/write memory.
- Restart and clean shutdown (gdbserver exits with the session).
- Added a `NASM IDE: make` task and launch defaults that read `APP`/`BUILD_DIR`/`TARGET` from a workspace Makefile. Debugging uses the unstripped ELF (`build/deforest`, not `-stripped`).

# 0.2.7

- Reverted "don't complete a finished token": VS Code's own word suggestions keep the widget open anyway, so hiding our items just removed useful candidates. Enter behavior is controlled by `editor.acceptSuggestionOnEnter` / `editor.wordBasedSuggestions` (scoped `[nasm]` settings work).
- Kept the 0.2.6 improvements: scoped local labels, emoji labels, and matching on the text before the caret.

# 0.2.6

- Completion no longer opens (or eats Enter) for a token that is already complete. Finishing `mov r12, r13` leaves the cursor alone until you press Enter once.
- Local labels are scope-aware: completion, hover, and F12 use the `.label` belonging to the enclosing non-local label instead of the first duplicate in the file. Hover notes the owner (e.g. "Local label under `addChoice`").
- Labels may contain non-ASCII bytes, so emoji labels such as `.height👍` parse, complete, and jump to definition.
- Completion matching uses the text before the caret while still replacing the whole qualified word.

# 0.2.5

- Library scanning now resolves GNU ld scripts (`INPUT(-lncursesw)` in `/usr/lib/libncurses.so`), so ncurses externs like `initscr`, `curs_set`, and `stdscr` no longer report as unresolved.
- Multilib systems: native architecture libraries are preferred over 32-bit `/usr/lib32` duplicates.
- Linker scripts are followed recursively, including static archives referenced from `GROUP(...)`.

# 0.2.4

- Language server start failures now show an actionable error instead of a silent `startFailed` state (e.g. VS Code's Electron binary replaced while it was running: fully quit and relaunch).
- "Restart language server" recreates the client after a failed start instead of failing with "Client is not running and can't be stopped".

# 0.2.3

- Stack checking follows control flow: `jmp`/conditional jumps to local labels are tracked, so a branch that skips the normal epilogue can pop on its own path without a false "pop without a matching push" error. Pair colors follow the same paths.
- Fixed flaky integration tests (client/server JSON-RPC id collision).

# 0.2.2

- .bss/.data definitions (`name resb N`, `name db ...`) are first-class symbols: completion, hover with sizes, goto-def.

# 0.2.2

- `.` triggers completion (member lists on `Name.`).
- Explicit textEdit ranges: accepting `Tool.pencil`/`.loop` no longer duplicates the qualifier.

# 0.2.1

- struc support: member completion after `Name.`, hover with offsets/sizes, cross-file goto-def, auto `Name_size`.

# 0.2.0

- FILO pair coloring via semantic tokens: each push cycles 6 colors, each pop wears its matching push's color.

# 0.1.9

- Stack pairing analysis: push/pop families highlighted distinctly, unpaired pushes/pops and unbalanced rets are errors.
- Settings merge with defaults so partial client configs can't silently disable features.

# 0.1.8

- Size/operator keywords share the dq/resq storage scope.

# 0.1.7

- Grammar: inc/dec highlighted as instructions; size/operator keywords (byte/dword/rel/...) no longer yellow.

# 0.1.6

- Library changes apply live (config re-fetch + index rebuild on change, no reload).
- Labels and all symbolic words scoped as entity.name.function (theme yellow).

# 0.1.5

- Autogenerated hover/completion docs for any configured library: .pc -> headers -> prototypes (nm-verified), man-page summaries, SysV ABI rendering.
- Harness speaks workspace/configuration; preprocessor lines no longer swallow prototypes.

# 0.1.4

- libc hover/completions render full System V ABI mapping (register per arg, rax vector rule, returns, clobbers) plus per-function return docs.

# 0.1.3

- 57 libc functions (printf, malloc, ...) with C signatures in completions/hover.
- Full README (architecture, config reference, doc comments).

# 0.1.0

Initial release:

- LSP completions / hover / goto-definition for NASM x86/x86-64.
- Doc comments (`@param` / `@return`, sizes, `;`/`;;` prefixes).
- Cross-file `extern` index with multiple-definition errors.
- Link library picker (`ldconfig` + compiler search dirs) and
  `nm`-based unresolved-`extern` warnings.
- As-you-type (debounced) or on-save diagnostics.
- `nasm-ide` build/run/clean task provider.
