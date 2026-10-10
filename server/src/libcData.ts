// Common C library functions callable from assembly via `extern` + `-lc`.
// Signatures follow the C standard library; `header` names the man-page
// section header for reference. Used for completions and hover only —
// link checking still comes from the configured libraries (nm index).
export interface LibcFunction {
    name: string;
    header: string;
    signature: string;
    summary: string;
}

const libcFunctions: LibcFunction[] = [
    // stdio.h
    { name: "printf", header: "stdio.h", signature: "int printf(const char *format, ...)", summary: "Print formatted output to stdout. Returns characters written." },
    { name: "fprintf", header: "stdio.h", signature: "int fprintf(FILE *stream, const char *format, ...)", summary: "Print formatted output to a stream." },
    { name: "sprintf", header: "stdio.h", signature: "int sprintf(char *str, const char *format, ...)", summary: "Print formatted output into a string buffer." },
    { name: "snprintf", header: "stdio.h", signature: "int snprintf(char *str, size_t size, const char *format, ...)", summary: "Print formatted output into a sized buffer (safe)." },
    { name: "scanf", header: "stdio.h", signature: "int scanf(const char *format, ...)", summary: "Read formatted input from stdin. Returns items assigned." },
    { name: "sscanf", header: "stdio.h", signature: "int sscanf(const char *str, const char *format, ...)", summary: "Read formatted input from a string." },
    { name: "puts", header: "stdio.h", signature: "int puts(const char *s)", summary: "Write a string plus newline to stdout." },
    { name: "putchar", header: "stdio.h", signature: "int putchar(int c)", summary: "Write a single character to stdout." },
    { name: "getchar", header: "stdio.h", signature: "int getchar(void)", summary: "Read a single character from stdin (EOF on end)." },
    { name: "fopen", header: "stdio.h", signature: "FILE *fopen(const char *path, const char *mode)", summary: "Open a file. Returns FILE* or NULL." },
    { name: "fclose", header: "stdio.h", signature: "int fclose(FILE *stream)", summary: "Close a stream. Returns 0 on success." },
    { name: "fread", header: "stdio.h", signature: "size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream)", summary: "Read nmemb items into ptr. Returns items read." },
    { name: "fwrite", header: "stdio.h", signature: "size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream)", summary: "Write nmemb items from ptr. Returns items written." },
    { name: "fflush", header: "stdio.h", signature: "int fflush(FILE *stream)", summary: "Flush buffered output. fflush(NULL) flushes all." },
    { name: "perror", header: "stdio.h", signature: "void perror(const char *s)", summary: "Print s plus the current errno message to stderr." },
    { name: "fgets", header: "stdio.h", signature: "char *fgets(char *s, int size, FILE *stream)", summary: "Read a line (at most size-1 chars). Returns s or NULL." },
    // stdlib.h
    { name: "malloc", header: "stdlib.h", signature: "void *malloc(size_t size)", summary: "Allocate size bytes (uninitialized). Returns pointer or NULL." },
    { name: "calloc", header: "stdlib.h", signature: "void *calloc(size_t nmemb, size_t size)", summary: "Allocate zeroed array. Returns pointer or NULL." },
    { name: "realloc", header: "stdlib.h", signature: "void *realloc(void *ptr, size_t size)", summary: "Resize allocation. Returns new pointer or NULL." },
    { name: "free", header: "stdlib.h", signature: "void free(void *ptr)", summary: "Release malloc/calloc/realloc memory. free(NULL) is a no-op." },
    { name: "exit", header: "stdlib.h", signature: "void exit(int status)", summary: "Flush stdio, run atexit handlers, terminate with status." },
    { name: "_exit", header: "unistd.h", signature: "void _exit(int status)", summary: "Terminate immediately without flushing stdio." },
    { name: "abort", header: "stdlib.h", signature: "void abort(void)", summary: "Terminate abnormally (SIGABRT)." },
    { name: "atoi", header: "stdlib.h", signature: "int atoi(const char *nptr)", summary: "String to int (no error reporting; prefer strtol)." },
    { name: "atol", header: "stdlib.h", signature: "long atol(const char *nptr)", summary: "String to long." },
    { name: "strtol", header: "stdlib.h", signature: "long strtol(const char *nptr, char **endptr, int base)", summary: "String to long with base and end pointer." },
    { name: "strtod", header: "stdlib.h", signature: "double strtod(const char *nptr, char **endptr)", summary: "String to double with end pointer." },
    { name: "rand", header: "stdlib.h", signature: "int rand(void)", summary: "Pseudo-random int in [0, RAND_MAX]." },
    { name: "srand", header: "stdlib.h", signature: "void srand(unsigned int seed)", summary: "Seed rand()." },
    { name: "system", header: "stdlib.h", signature: "int system(const char *command)", summary: "Run a shell command. Returns shell exit status." },
    { name: "getenv", header: "stdlib.h", signature: "char *getenv(const char *name)", summary: "Get environment variable. Returns value or NULL." },
    { name: "qsort", header: "stdlib.h", signature: "void qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *))", summary: "Sort array with comparator callback." },
    { name: "abs", header: "stdlib.h", signature: "int abs(int j)", summary: "Absolute value of int." },
    // string.h
    { name: "strlen", header: "string.h", signature: "size_t strlen(const char *s)", summary: "Length of string excluding NUL." },
    { name: "strcpy", header: "string.h", signature: "char *strcpy(char *dest, const char *src)", summary: "Copy string including NUL (unsafe; check size)." },
    { name: "strncpy", header: "string.h", signature: "char *strncpy(char *dest, const char *src, size_t n)", summary: "Copy at most n chars (may not NUL-terminate)." },
    { name: "strcat", header: "string.h", signature: "char *strcat(char *dest, const char *src)", summary: "Append src to dest." },
    { name: "strcmp", header: "string.h", signature: "int strcmp(const char *s1, const char *s2)", summary: "Compare strings. 0 if equal, <0 / >0 otherwise." },
    { name: "strncmp", header: "string.h", signature: "int strncmp(const char *s1, const char *s2, size_t n)", summary: "Compare at most n chars." },
    { name: "memcpy", header: "string.h", signature: "void *memcpy(void *dest, const void *src, size_t n)", summary: "Copy n bytes (regions must not overlap)." },
    { name: "memmove", header: "string.h", signature: "void *memmove(void *dest, const void *src, size_t n)", summary: "Copy n bytes (overlap-safe)." },
    { name: "memset", header: "string.h", signature: "void *memset(void *s, int c, size_t n)", summary: "Fill n bytes with byte c." },
    { name: "memcmp", header: "string.h", signature: "int memcmp(const void *s1, const void *s2, size_t n)", summary: "Compare n bytes. 0 if equal." },
    { name: "strdup", header: "string.h", signature: "char *strdup(const char *s)", summary: "Duplicate string with malloc. Free it after." },
    { name: "strchr", header: "string.h", signature: "char *strchr(const char *s, int c)", summary: "First occurrence of c in s, or NULL." },
    { name: "strtok", header: "string.h", signature: "char *strtok(char *str, const char *delim)", summary: "Split string into tokens (stateful; not thread-safe)." },
    // unistd.h
    { name: "read", header: "unistd.h", signature: "ssize_t read(int fd, void *buf, size_t count)", summary: "Raw fd read. Returns bytes read, 0 on EOF, -1 on error." },
    { name: "write", header: "unistd.h", signature: "ssize_t write(int fd, const void *buf, size_t count)", summary: "Raw fd write. Returns bytes written." },
    { name: "open", header: "fcntl.h", signature: "int open(const char *path, int flags, ...)", summary: "Open file, return fd (flags: O_RDONLY/O_WRONLY/O_RDWR/O_CREAT...)." },
    { name: "close", header: "unistd.h", signature: "int close(int fd)", summary: "Close a file descriptor." },
    { name: "sleep", header: "unistd.h", signature: "unsigned int sleep(unsigned int seconds)", summary: "Sleep seconds (returns unslept remainder)." },
    { name: "usleep", header: "unistd.h", signature: "int usleep(useconds_t usec)", summary: "Sleep microseconds." },
    // math.h (-lm)
    { name: "sin", header: "math.h (-lm)", signature: "double sin(double x)", summary: "Sine of x radians. Link with -lm." },
    { name: "cos", header: "math.h (-lm)", signature: "double cos(double x)", summary: "Cosine of x radians. Link with -lm." },
    { name: "sqrt", header: "math.h (-lm)", signature: "double sqrt(double x)", summary: "Square root. Link with -lm." },
    { name: "pow", header: "math.h (-lm)", signature: "double pow(double x, double y)", summary: "x raised to y. Link with -lm." },
    { name: "fabs", header: "math.h (-lm)", signature: "double fabs(double x)", summary: "Absolute value of double. Link with -lm." },
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
