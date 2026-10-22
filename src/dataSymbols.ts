// Small .data/.bss declaration scanner for the debugger's Data scope.
//
// NASM does not emit DWARF variable types for plain labels, and the ELF
// symbol sizes are often missing (or are just 1 byte).  Source declarations
// are the reliable place to learn which labels are variables and how much
// memory each one covers.  Addresses still come from gdb.
import * as fs from "fs";
import * as path from "path";

export interface DataSymbol {
    /** Full gdb symbol name, e.g. `Window.rows` or `GameState`. */
    name: string;
    /** Name shown in the Variables view (children lose their parent prefix). */
    displayName: string;
    file: string;
    line: number;
    section: string;
    /** NASM data directive (db/dw/dd/dq/resb/resw/...). */
    type: string;
    /** Byte size when it can be determined from the source. */
    size?: number;
    /** Initializer text, used as a hint in the variable type/description. */
    initializer?: string;
    /** A bare label that only groups following local labels (e.g. a struct). */
    aggregate: boolean;
    /** Parsed address from gdb, filled in by the adapter. */
    address?: number;
}

const SKIP_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    ".vscode",
    ".vscode-oss",
    "node_modules",
    "build",
    "bin",
    "obj",
    "out",
    "dist",
    "target",
    "vendor",
]);

const DATA_SECTIONS = new Set([".data", ".bss"]);

/** Strip a NASM comment while respecting quoted strings. */
function stripComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === "\\") {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
        } else if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
        } else if (ch === ";") {
            return line.slice(0, i);
        }
    }
    return line;
}

function collectAsmFiles(root: string): string[] {
    const files: string[] = [];
    const seen = new Set<string>();
    const visit = (dir: string, depth: number): void => {
        if (depth > 6 || files.length >= 500) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (files.length >= 500) {
                return;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !seen.has(full)) {
                    seen.add(full);
                    visit(full, depth + 1);
                }
            } else if (entry.isFile() && /\.(asm|nasm|s)$/i.test(entry.name)) {
                files.push(full);
            }
        }
    };
    visit(root, 0);
    return files;
}

function decodeQuoted(text: string): string {
    const quote = text[0];
    const body = text.slice(1, -1);
    // NASM only processes backslash escapes in backtick strings.  Single and
    // double quotes are literal byte strings.
    if (quote !== "`") {
        return body;
    }
    let out = "";
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== "\\" || i + 1 >= body.length) {
            out += ch;
            continue;
        }
        const next = body[++i];
        const simple: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            v: "\v",
            f: "\f",
            a: "\x07",
            e: "\x1b",
            "\\": "\\",
            "'": "'",
            '"': '"',
            "`": "`",
        };
        if (simple[next] !== undefined) {
            out += simple[next];
        } else if (next === "x" && i + 2 < body.length) {
            const hex = body.slice(i + 1, i + 3);
            if (/^[0-9a-f]{2}$/i.test(hex)) {
                out += String.fromCharCode(parseInt(hex, 16));
                i += 2;
            } else {
                out += next;
            }
        } else {
            out += next;
        }
    }
    return out;
}

/** Split initializer items on commas that are not inside quotes or brackets. */
function splitItems(text: string): string[] {
    const items: string[] = [];
    let current = "";
    let quote: string | null = null;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            current += ch;
            if (ch === "\\") {
                if (i + 1 < text.length) {
                    current += text[++i];
                }
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            current += ch;
        } else if (ch === "(" || ch === "[" || ch === "{") {
            depth++;
            current += ch;
        } else if (ch === ")" || ch === "]" || ch === "}") {
            depth = Math.max(0, depth - 1);
            current += ch;
        } else if (ch === "," && depth === 0) {
            items.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim() || text.trim() === ",") {
        items.push(current.trim());
    }
    return items;
}

// A deliberately small expression evaluator for `resb MapSize * MapSize` and
// similar NASM counts.  It accepts integer arithmetic and already-collected
// symbolic constants; anything else yields undefined.
function evaluateExpression(expression: string, constants: Map<string, number>): number | undefined {
    let text = expression.trim();
    if (!text) {
        return undefined;
    }
    // Strip a trailing `;` comment (normally already removed) and any size
    // keywords that occasionally appear in data declarations.
    text = text.replace(/;\s*.*$/, "").trim();
    if (!text) {
        return undefined;
    }
    const tokenPattern = /\s*(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+|[A-Za-z_.$?][\w.$?@]*|<<|>>|[()+\-*/%&|^~])/giy;
    const tokens: string[] = [];
    let last = 0;
    for (;;) {
        tokenPattern.lastIndex = last;
        const match = tokenPattern.exec(text);
        if (!match) {
            break;
        }
        if (match.index !== last) {
            return undefined;
        }
        tokens.push(match[1]);
        last = tokenPattern.lastIndex;
    }
    if (last !== text.length || tokens.length === 0) {
        return undefined;
    }
    let pos = 0;
    const peek = (): string | undefined => tokens[pos];
    const take = (): string | undefined => tokens[pos++];
    const parsePrimary = (): number | undefined => {
        const token = take();
        if (!token) {
            return undefined;
        }
        if (token === "(") {
            const value = parseBitOr();
            if (take() !== ")") {
                return undefined;
            }
            return value;
        }
        if (token === "+" || token === "-" || token === "~") {
            const value = parsePrimary();
            if (value === undefined) {
                return undefined;
            }
            return token === "-" ? -value : token === "~" ? ~value : value;
        }
        if (/^0x[0-9a-f]+$/i.test(token)) {
            return parseInt(token.slice(2), 16);
        }
        if (/^0b[01]+$/i.test(token)) {
            return parseInt(token.slice(2), 2);
        }
        if (/^0o[0-7]+$/i.test(token)) {
            return parseInt(token.slice(2), 8);
        }
        if (/^\d+$/.test(token)) {
            return parseInt(token, 10);
        }
        if (/^[A-Za-z_.$?][\w.$?@]*$/.test(token)) {
            return constants.get(token);
        }
        return undefined;
    };
    const binary = (
        next: () => number | undefined,
        operators: string[],
        apply: (op: string, a: number, b: number) => number
    ): (() => number | undefined) => {
        return () => {
            let left = next();
            for (;;) {
                const op = peek();
                if (!op || !operators.includes(op)) {
                    return left;
                }
                take();
                const right = next();
                if (left === undefined || right === undefined) {
                    return undefined;
                }
                left = apply(op, left, right);
            }
        };
    };
    const parseMul = binary(parsePrimary, ["*", "/", "%"], (op, a, b) => {
        if ((op === "/" || op === "%") && b === 0) {
            return NaN;
        }
        return op === "*" ? a * b : op === "/" ? Math.trunc(a / b) : a % b;
    });
    const parseAdd = binary(parseMul, ["+", "-"], (op, a, b) => (op === "+" ? a + b : a - b));
    const parseShift = binary(parseAdd, ["<<", ">>"], (op, a, b) => (op === "<<" ? a << b : a >> b));
    const parseBitAnd = binary(parseShift, ["&"], (_op, a, b) => a & b);
    const parseBitXor = binary(parseBitAnd, ["^"], (_op, a, b) => a ^ b);
    const parseBitOr = binary(parseBitXor, ["|"], (_op, a, b) => a | b);
    const result = parseBitOr();
    if (pos !== tokens.length || result === undefined || !Number.isFinite(result)) {
        return undefined;
    }
    return result;
}

function stringBytesLength(value: string): number {
    // NASM strings are byte strings.  Count UTF-8 bytes for non-ASCII text.
    return Buffer.byteLength(value, "utf8");
}

function initializerSize(op: string, rest: string, constants: Map<string, number>): number | undefined {
    const lower = op.toLowerCase();
    const elementSize: Record<string, number> = {
        db: 1, dw: 2, dd: 4, dq: 8, dt: 10, do: 16, dy: 32, dz: 64,
    };
    const elem = elementSize[lower];
    if (elem === undefined) {
        return undefined;
    }
    if (!rest.trim()) {
        return 0;
    }
    let total = 0;
    for (const item of splitItems(rest)) {
        if (!item) {
            continue;
        }
        if (/^['"`]/.test(item)) {
            const end = item[item.length - 1];
            if (end === item[0]) {
                const decoded = decodeQuoted(item);
                if (lower === "db") {
                    total += stringBytesLength(decoded);
                } else {
                    total += Math.max(1, Math.ceil(stringBytesLength(decoded) / elem)) * elem;
                }
                continue;
            }
        }
        // `?` means uninitialized (unusual in .data, but NASM permits it).
        if (item === "?") {
            total += elem;
            continue;
        }
        // A `times`-prefixed item is uncommon in these tables; count it as one
        // element rather than guessing.  Address deltas still provide a size.
        total += elem;
    }
    return total;
}

function dirSize(op: string): number | undefined {
    const sizes: Record<string, number> = {
        resb: 1, resw: 2, resd: 4, resq: 8, rest: 10, reso: 16, resy: 32, resz: 64,
    };
    return sizes[op.toLowerCase()];
}

function normalizeSection(raw: string): string {
    return raw.trim().replace(/:+$/, "").toLowerCase();
}

function parseFile(file: string, constants: Map<string, number>, output: DataSymbol[]): void {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return;
    }
    const lines = text.split(/\r?\n/);
    let section = ".text";
    let parent = "";
    let pending: DataSymbol | null = null;

    const add = (symbol: DataSymbol): DataSymbol => {
        output.push(symbol);
        return symbol;
    };

    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index];
        const code = stripComment(rawLine);
        const trimmed = code.trim();
        if (!trimmed) {
            continue;
        }

        const sectionMatch = /^\s*(?:section|segment)\s+([^\s,]+)/i.exec(code);
        if (sectionMatch) {
            section = normalizeSection(sectionMatch[1]);
            parent = "";
            pending = null;
            continue;
        }
        if (!DATA_SECTIONS.has(section)) {
            continue;
        }

        // %define / %assign constants are useful in reservation counts.
        const defineMatch = /^\s*%(?:define|assign)\s+([A-Za-z_.$?][\w.$?@]*)\s+(.+)$/i.exec(code);
        if (defineMatch) {
            const value = evaluateExpression(defineMatch[2], constants);
            if (value !== undefined) {
                constants.set(defineMatch[1], value);
            }
            continue;
        }

        // `name equ expr` is a constant, not a memory variable.
        const equMatch = /^\s*([A-Za-z_.$?][\w.$?@]*)\s+equ\s+(.+)$/i.exec(code);
        if (equMatch) {
            const value = evaluateExpression(equMatch[2], constants);
            if (value !== undefined) {
                constants.set(equMatch[1], value);
            }
            continue;
        }

        // Label, optionally with data on the same line:
        //   CursorMove:
        //   space db ' ', 0
        //   Window:
        //       .rows resw 1
        const labelData = /^\s*([A-Za-z_.$?][\w.$?@]*)\s*:\s*(.*)$/.exec(code);
        if (labelData) {
            const rawName = labelData[1];
            const rest = labelData[2].trim();
            const local = rawName.startsWith(".");
            const fullName = local && parent ? `${parent}${rawName}` : rawName;
            if (!local) {
                parent = rawName;
            }
            const dataMatch = /^(res[bwdqtozy]|db|dw|dd|dq|dt|do|dy|dz)\b\s*(.*)$/i.exec(rest);
            if (dataMatch) {
                const op = dataMatch[1].toLowerCase();
                const count = dirSize(op);
                const size = count !== undefined
                    ? (() => {
                          const n = evaluateExpression(dataMatch[2], constants);
                          return n === undefined ? undefined : Math.max(0, n) * count;
                      })()
                    : initializerSize(op, dataMatch[2] || "", constants);
                add({
                    name: fullName,
                    displayName: local ? rawName : fullName,
                    file,
                    line: index,
                    section,
                    type: op,
                    size,
                    initializer: dataMatch[2]?.trim() || undefined,
                    aggregate: false,
                });
                pending = null;
            } else {
                const symbol = add({
                    name: fullName,
                    displayName: local ? rawName : fullName,
                    file,
                    line: index,
                    section,
                    type: local ? "struct" : "label",
                    size: undefined,
                    aggregate: true,
                });
                pending = rest ? null : symbol;
            }
            continue;
        }

        // Data definition without a colon:
        //   space db ' ', 0
        //   Key resd 1
        const dataOnly = /^\s*([A-Za-z_.$?][\w.$?@]*)\s+(res[bwdqtozy]|db|dw|dd|dq|dt|do|dy|dz)\b\s*(.*)$/i.exec(code);
        if (dataOnly) {
            const rawName = dataOnly[1];
            const op = dataOnly[2].toLowerCase();
            const rest = dataOnly[3] || "";
            const local = rawName.startsWith(".");
            const fullName = local && parent ? `${parent}${rawName}` : rawName;
            if (!local) {
                parent = rawName;
            }
            const count = dirSize(op);
            const size = count !== undefined
                ? (() => {
                      const n = evaluateExpression(rest, constants);
                      return n === undefined ? undefined : Math.max(0, n) * count;
                  })()
                : initializerSize(op, rest, constants);
            add({
                name: fullName,
                displayName: local ? rawName : fullName,
                file,
                line: index,
                section,
                type: op,
                size,
                initializer: rest.trim() || undefined,
                aggregate: false,
            });
            pending = null;
            continue;
        }

        // A bare label followed by a data line: attach the data to the label.
        if (pending && /^\s*(res[bwdqtozy]|db|dw|dd|dq|dt|do|dy|dz)\b/i.test(code)) {
            const match = /^\s*(res[bwdqtozy]|db|dw|dd|dq|dt|do|dy|dz)\b\s*(.*)$/i.exec(code);
            if (match) {
                const op = match[1].toLowerCase();
                const rest = match[2] || "";
                const count = dirSize(op);
                const size = count !== undefined
                    ? (() => {
                          const n = evaluateExpression(rest, constants);
                          return n === undefined ? undefined : Math.max(0, n) * count;
                      })()
                    : initializerSize(op, rest, constants);
                pending.type = op;
                pending.size = size;
                pending.initializer = rest.trim() || undefined;
                pending.aggregate = false;
                pending = null;
            }
            continue;
        }

        // Any other statement in a data section means a pending bare label was
        // only a label (or an equ), not the start of a data definition.
        if (!/^\s*\./.test(code)) {
            pending = null;
        }
    }
}

/**
 * Scan the workspace for labels declared in .data/.bss.  Only declarations
 * whose address appears in the running program will be shown; addresses are
 * supplied by the caller from gdb.
 */
export function loadDataSymbols(cwd: string): DataSymbol[] {
    const symbols: DataSymbol[] = [];
    const constants = new Map<string, number>();
    for (const file of collectAsmFiles(cwd)) {
        parseFile(file, constants, symbols);
    }
    return symbols;
}
