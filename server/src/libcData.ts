// Common C library functions callable from assembly via `extern` + `-lc`.
// Signatures follow the C standard library; `header` names the man-page
// section header for reference. Used for completions and hover only —
// link checking still comes from the configured libraries (nm index).
export interface LibcFunction {
    name: string;
    header: string;
    signature: string;
    summary: string;
    /** Short `rax`-value description shown under Returns. */
    returns: string;
}

const libcFunctions: LibcFunction[] = [
    // stdio.h
    { name: "printf", header: "stdio.h", signature: "int printf(const char *format, ...)", summary: "Print formatted output to stdout. Returns characters written.", returns: "number of characters written, or negative on error" },
    { name: "fprintf", header: "stdio.h", signature: "int fprintf(FILE *stream, const char *format, ...)", summary: "Print formatted output to a stream.", returns: "number of characters written, or negative on error" },
    { name: "sprintf", header: "stdio.h", signature: "int sprintf(char *str, const char *format, ...)", summary: "Print formatted output into a string buffer.", returns: "number of chars written (excluding NUL)" },
    { name: "snprintf", header: "stdio.h", signature: "int snprintf(char *str, size_t size, const char *format, ...)", summary: "Print formatted output into a sized buffer (safe).", returns: "number of chars that would have been written" },
    { name: "scanf", header: "stdio.h", signature: "int scanf(const char *format, ...)", summary: "Read formatted input from stdin. Returns items assigned.", returns: "number of items assigned, or EOF on failure" },
    { name: "sscanf", header: "stdio.h", signature: "int sscanf(const char *str, const char *format, ...)", summary: "Read formatted input from a string.", returns: "number of items assigned, or EOF on failure" },
    { name: "puts", header: "stdio.h", signature: "int puts(const char *s)", summary: "Write a string plus newline to stdout.", returns: "nonnegative on success, EOF on error" },
    { name: "putchar", header: "stdio.h", signature: "int putchar(int c)", summary: "Write a single character to stdout.", returns: "character written as unsigned char, or EOF" },
    { name: "getchar", header: "stdio.h", signature: "int getchar(void)", summary: "Read a single character from stdin (EOF on end).", returns: "character read, or EOF" },
    { name: "fopen", header: "stdio.h", signature: "FILE *fopen(const char *path, const char *mode)", summary: "Open a file. Returns FILE* or NULL.", returns: "FILE pointer, or NULL on error" },
    { name: "fclose", header: "stdio.h", signature: "int fclose(FILE *stream)", summary: "Close a stream. Returns 0 on success.", returns: "0 on success, EOF on error" },
    { name: "fread", header: "stdio.h", signature: "size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream)", summary: "Read nmemb items into ptr. Returns items read.", returns: "number of items read" },
    { name: "fwrite", header: "stdio.h", signature: "size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream)", summary: "Write nmemb items from ptr. Returns items written.", returns: "number of items written" },
    { name: "fflush", header: "stdio.h", signature: "int fflush(FILE *stream)", summary: "Flush buffered output. fflush(NULL) flushes all.", returns: "0 on success, EOF on error" },
    { name: "perror", header: "stdio.h", signature: "void perror(const char *s)", summary: "Print s plus the current errno message to stderr.", returns: "nothing" },
    { name: "fgets", header: "stdio.h", signature: "char *fgets(char *s, int size, FILE *stream)", summary: "Read a line (at most size-1 chars). Returns s or NULL.", returns: "s on success, NULL on failure" },
    // stdlib.h
    { name: "malloc", header: "stdlib.h", signature: "void *malloc(size_t size)", summary: "Allocate size bytes (uninitialized). Returns pointer or NULL.", returns: "pointer to allocated memory, or NULL" },
    { name: "calloc", header: "stdlib.h", signature: "void *calloc(size_t nmemb, size_t size)", summary: "Allocate zeroed array. Returns pointer or NULL.", returns: "pointer to zeroed memory, or NULL" },
    { name: "realloc", header: "stdlib.h", signature: "void *realloc(void *ptr, size_t size)", summary: "Resize allocation. Returns new pointer or NULL.", returns: "new pointer, or NULL (old block kept)" },
    { name: "free", header: "stdlib.h", signature: "void free(void *ptr)", summary: "Release malloc/calloc/realloc memory. free(NULL) is a no-op.", returns: "nothing" },
    { name: "exit", header: "stdlib.h", signature: "void exit(int status)", summary: "Flush stdio, run atexit handlers, terminate with status.", returns: "does not return" },
    { name: "_exit", header: "unistd.h", signature: "void _exit(int status)", summary: "Terminate immediately without flushing stdio.", returns: "does not return" },
    { name: "abort", header: "stdlib.h", signature: "void abort(void)", summary: "Terminate abnormally (SIGABRT).", returns: "does not return" },
    { name: "atoi", header: "stdlib.h", signature: "int atoi(const char *nptr)", summary: "String to int (no error reporting; prefer strtol).", returns: "converted int" },
    { name: "atol", header: "stdlib.h", signature: "long atol(const char *nptr)", summary: "String to long.", returns: "converted long" },
    { name: "strtol", header: "stdlib.h", signature: "long strtol(const char *nptr, char **endptr, int base)", summary: "String to long with base and end pointer.", returns: "converted long; endptr set past the number" },
    { name: "strtod", header: "stdlib.h", signature: "double strtod(const char *nptr, char **endptr)", summary: "String to double with end pointer.", returns: "converted double; endptr set past the number" },
    { name: "rand", header: "stdlib.h", signature: "int rand(void)", summary: "Pseudo-random int in [0, RAND_MAX].", returns: "pseudo-random int in [0, RAND_MAX]" },
    { name: "srand", header: "stdlib.h", signature: "void srand(unsigned int seed)", summary: "Seed rand().", returns: "nothing" },
    { name: "system", header: "stdlib.h", signature: "int system(const char *command)", summary: "Run a shell command. Returns shell exit status.", returns: "shell exit status of the command, or -1" },
    { name: "getenv", header: "stdlib.h", signature: "char *getenv(const char *name)", summary: "Get environment variable. Returns value or NULL.", returns: "value string, or NULL if unset" },
    { name: "qsort", header: "stdlib.h", signature: "void qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *))", summary: "Sort array with comparator callback.", returns: "nothing" },
    { name: "abs", header: "stdlib.h", signature: "int abs(int j)", summary: "Absolute value of int.", returns: "absolute value" },
    // string.h
    { name: "strlen", header: "string.h", signature: "size_t strlen(const char *s)", summary: "Length of string excluding NUL.", returns: "string length excluding NUL" },
    { name: "strcpy", header: "string.h", signature: "char *strcpy(char *dest, const char *src)", summary: "Copy string including NUL (unsafe; check size).", returns: "dest" },
    { name: "strncpy", header: "string.h", signature: "char *strncpy(char *dest, const char *src, size_t n)", summary: "Copy at most n chars (may not NUL-terminate).", returns: "dest" },
    { name: "strcat", header: "string.h", signature: "char *strcat(char *dest, const char *src)", summary: "Append src to dest.", returns: "dest" },
    { name: "strcmp", header: "string.h", signature: "int strcmp(const char *s1, const char *s2)", summary: "Compare strings. 0 if equal, <0 / >0 otherwise.", returns: "0 if equal, negative or positive otherwise" },
    { name: "strncmp", header: "string.h", signature: "int strncmp(const char *s1, const char *s2, size_t n)", summary: "Compare at most n chars.", returns: "0 if equal, negative or positive otherwise" },
    { name: "memcpy", header: "string.h", signature: "void *memcpy(void *dest, const void *src, size_t n)", summary: "Copy n bytes (regions must not overlap).", returns: "dest" },
    { name: "memmove", header: "string.h", signature: "void *memmove(void *dest, const void *src, size_t n)", summary: "Copy n bytes (overlap-safe).", returns: "dest" },
    { name: "memset", header: "string.h", signature: "void *memset(void *s, int c, size_t n)", summary: "Fill n bytes with byte c.", returns: "s" },
    { name: "memcmp", header: "string.h", signature: "int memcmp(const void *s1, const void *s2, size_t n)", summary: "Compare n bytes. 0 if equal.", returns: "0 if the bytes are equal" },
    { name: "strdup", header: "string.h", signature: "char *strdup(const char *s)", summary: "Duplicate string with malloc. Free it after.", returns: "new string (free it), or NULL" },
    { name: "strchr", header: "string.h", signature: "char *strchr(const char *s, int c)", summary: "First occurrence of c in s, or NULL.", returns: "pointer to the match, or NULL" },
    { name: "strtok", header: "string.h", signature: "char *strtok(char *str, const char *delim)", summary: "Split string into tokens (stateful; not thread-safe).", returns: "next token, or NULL" },
    // unistd.h
    { name: "read", header: "unistd.h", signature: "ssize_t read(int fd, void *buf, size_t count)", summary: "Raw fd read. Returns bytes read, 0 on EOF, -1 on error.", returns: "bytes read, 0 on EOF, -1 on error" },
    { name: "write", header: "unistd.h", signature: "ssize_t write(int fd, const void *buf, size_t count)", summary: "Raw fd write. Returns bytes written.", returns: "bytes written, or -1 on error" },
    { name: "open", header: "fcntl.h", signature: "int open(const char *path, int flags, ...)", summary: "Open file, return fd (flags: O_RDONLY/O_WRONLY/O_RDWR/O_CREAT...).", returns: "file descriptor, or -1 on error" },
    { name: "close", header: "unistd.h", signature: "int close(int fd)", summary: "Close a file descriptor.", returns: "0 on success, -1 on error" },
    { name: "sleep", header: "unistd.h", signature: "unsigned int sleep(unsigned int seconds)", summary: "Sleep seconds (returns unslept remainder).", returns: "unslept seconds (0 if slept fully)" },
    { name: "usleep", header: "unistd.h", signature: "int usleep(useconds_t usec)", summary: "Sleep microseconds.", returns: "0 on success, -1 on error" },
    // math.h (-lm)
    { name: "sin", header: "math.h (-lm)", signature: "double sin(double x)", summary: "Sine of x radians. Link with -lm.", returns: "result as double" },
    { name: "cos", header: "math.h (-lm)", signature: "double cos(double x)", summary: "Cosine of x radians. Link with -lm.", returns: "result as double" },
    { name: "sqrt", header: "math.h (-lm)", signature: "double sqrt(double x)", summary: "Square root. Link with -lm.", returns: "result as double" },
    { name: "pow", header: "math.h (-lm)", signature: "double pow(double x, double y)", summary: "x raised to y. Link with -lm.", returns: "result as double" },
    { name: "fabs", header: "math.h (-lm)", signature: "double fabs(double x)", summary: "Absolute value of double. Link with -lm.", returns: "result as double" },
];

const libcIndex = new Map<string, LibcFunction>();
for (const fn of libcFunctions) {
    libcIndex.set(fn.name.toLowerCase(), fn);
}

export function getLibcFunction(name: string): LibcFunction | undefined {
    return libcIndex.get(name.toLowerCase());
}

export function getLibcCompletions(prefix: string): LibcFunction[] {
    const lower = prefix.toLowerCase();
    return libcFunctions.filter((fn) => fn.name.startsWith(lower));
}

// System V AMD64 calling-convention rendering: map each C parameter to the
// register (or stack slot) an assembly caller must put it in.
const GPR_ORDER = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const SSE_ORDER = ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"];

function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
        }
        if (ch === "," && depth === 0) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) {
        parts.push(cur);
    }
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function paramName(decl: string): string {
    const fp = /\(\*\s*(\w+)\s*\)/.exec(decl);
    if (fp) {
        return fp[1];
    }
    const m = /([A-Za-z_]\w*)\s*(\[[\s\d]*\])?$/.exec(decl.trim());
    return m ? m[1] : "";
}

function isFloatParam(decl: string): boolean {
    return /\b(float|double)\b/.test(decl) && !decl.includes("*");
}

export interface AbiParam {
    loc: string;
    name: string;
    type: string;
}

export function abiParams(fn: LibcFunction): { params: AbiParam[]; variadic: boolean } {
    const open = fn.signature.indexOf(`${fn.name}(`);
    if (open < 0) {
        return { params: [], variadic: false };
    }
    let depth = 0;
    let close = -1;
    for (let i = open + fn.name.length; i < fn.signature.length; i++) {
        if (fn.signature[i] === "(") {
            depth++;
        } else if (fn.signature[i] === ")") {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close < 0) {
        return { params: [], variadic: false };
    }
    const raw = splitTopLevel(fn.signature.slice(open + fn.name.length + 1, close));
    if (raw.length === 1 && raw[0] === "void") {
        return { params: [], variadic: false };
    }
    const params: AbiParam[] = [];
    let gpr = 0;
    let sse = 0;
    let variadic = false;
    for (const decl of raw) {
        if (decl === "...") {
            variadic = true;
            continue;
        }
        const float = isFloatParam(decl);
        let loc: string;
        if (float) {
            loc = sse < SSE_ORDER.length ? SSE_ORDER[sse++] : "stack";
        } else {
            loc = gpr < GPR_ORDER.length ? GPR_ORDER[gpr++] : "stack";
        }
        params.push({ loc, name: paramName(decl), type: decl.replace(/\s+/g, " ") });
    }
    return { params, variadic };
}

export function abiReturn(fn: LibcFunction): string {
    const ret = fn.signature.slice(0, fn.signature.indexOf(`${fn.name}(`)).trim();
    if (!ret) {
        return "rax";
    }
    if (/\bvoid\b/.test(ret) && !ret.includes("*")) {
        return "";
    }
    if (/\b(float|double)\b/.test(ret) && !ret.includes("*")) {
        return "xmm0";
    }
    return "rax";
}

/** Full hover/completion markdown for a libc function. */
export function renderLibcFunction(fn: LibcFunction, linkHint?: string): string {
    const lines: string[] = [];
    lines.push("```c");
    lines.push(fn.signature);
    lines.push("```");
    lines.push("");
    lines.push(fn.summary);
    const { params, variadic } = abiParams(fn);
    if (params.length > 0 || variadic) {
        lines.push("");
        lines.push("**Parameters** (System V AMD64)");
        lines.push("");
        for (const p of params) {
            const what = p.name ? `${p.name}: \`${p.type}\`` : `\`${p.type}\``;
            lines.push(`- \`${p.loc}\` - ${what}`);
        }
        if (variadic) {
            lines.push("- `...` - further args in remaining registers, then on the stack");
            lines.push("- `rax` - number of vector registers used (0 if none)");
        }
    }
    const retLoc = abiReturn(fn);
    if (retLoc && fn.returns) {
        lines.push("");
        lines.push("**Returns**");
        lines.push("");
        lines.push(`- \`${retLoc}\` - ${fn.returns}`);
    }
    const lib = linkHint ?? (fn.header.includes("-lm") ? "-lm" : "-lc");
    lines.push("");
    lines.push(`C library (${fn.header}) \u2014 link with \`${lib}\`.`);
    lines.push("Calls clobber `rax`, `rcx`, `rdx`, `rsi`, `rdi`, `r8`–`r11`; `rbx`, `rbp`, `r12`–`r15` are preserved.");
    return lines.join("\n");
}
