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
