// Minimal GDB/MI client used by the NASM debug adapter.
// Speaks the MI2 line protocol over stdio and exposes records as promises
// plus async events (`stop`, `running`, `console`, `target`, `exit`).
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";

export type MiValue = string | MiValue[] | MiTuple;
export type MiTuple = { [key: string]: MiValue };

export interface MiRecord {
    token?: number;
    /** '^' result, '*' async exec, '+'/ '=' notify, '~'/'@'/'&' streams. */
    kind: string;
    className?: string;
    results: MiTuple;
    stream?: string;
    raw: string;
}

export interface MiResultRecord extends MiRecord {
    className: string;
}

/** Parse one MI value starting at `pos`; returns the value and new position. */
export function parseMiValue(text: string, pos: number): { value: MiValue; pos: number } {
    const skip = (): void => {
        while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) {
            pos++;
        }
    };
    skip();
    const ch = text[pos];
    if (ch === '"') {
        pos++;
        let out = "";
        while (pos < text.length) {
            const c = text[pos++];
            if (c === '"') {
                break;
            }
            if (c !== "\\") {
                out += c;
                continue;
            }
            const e = text[pos++];
            switch (e) {
                case "n":
                    out += "\n";
                    break;
                case "t":
                    out += "\t";
                    break;
                case "r":
                    out += "\r";
                    break;
                case "f":
                    out += "\f";
                    break;
                case "b":
                    out += "\b";
                    break;
                case "v":
                    out += "\v";
                    break;
                case "a":
                    out += "\x07";
                    break;
                case "\\":
                    out += "\\";
                    break;
                case '"':
                    out += '"';
                    break;
                default:
                    if (e >= "0" && e <= "7") {
                        let oct = e;
                        while (oct.length < 3 && pos < text.length && text[pos] >= "0" && text[pos] <= "7") {
                            oct += text[pos++];
                        }
                        out += String.fromCharCode(parseInt(oct, 8));
                    } else {
                        out += e ?? "";
                    }
            }
        }
        return { value: out, pos };
    }
    if (ch === "{") {
        pos++;
        const tuple: MiTuple = {};
        skip();
        while (pos < text.length && text[pos] !== "}") {
            const keyStart = pos;
            while (pos < text.length && text[pos] !== "=" && text[pos] !== "," && text[pos] !== "}") {
                pos++;
            }
            const key = text.slice(keyStart, pos).trim();
            skip();
            if (text[pos] === "=") {
                pos++;
                const parsed = parseMiValue(text, pos);
                tuple[key] = parsed.value;
                pos = parsed.pos;
            } else if (key.length > 0) {
                tuple[key] = "";
            }
            skip();
            if (text[pos] === ",") {
                pos++;
                skip();
            }
        }
        if (text[pos] === "}") {
            pos++;
        }
        return { value: tuple, pos };
    }
    if (ch === "[") {
        pos++;
        const list: MiValue[] = [];
        skip();
        while (pos < text.length && text[pos] !== "]") {
            // List entries are often `key=value`; the key is structural
            // (`frame=`, `thread=`), so keep the value.
            const save = pos;
            while (pos < text.length && text[pos] !== "=" && text[pos] !== "," && text[pos] !== "]") {
                pos++;
            }
            const maybeKey = text.slice(save, pos).trim();
            if (text[pos] === "=" && /^[A-Za-z0-9_.-]+$/.test(maybeKey)) {
                pos++;
            } else if (maybeKey.length === 0 && text[pos] === ",") {
                // empty element
            } else {
                pos = save;
            }
            const parsed = parseMiValue(text, pos);
            list.push(parsed.value);
            pos = parsed.pos;
            skip();
            if (text[pos] === ",") {
                pos++;
                skip();
            }
        }
        if (text[pos] === "]") {
            pos++;
        }
        return { value: list, pos };
    }
    // Bare token: read until a structural delimiter.
    const start = pos;
    while (pos < text.length && text[pos] !== "," && text[pos] !== "}" && text[pos] !== "]") {
        pos++;
    }
    return { value: text.slice(start, pos).trim(), pos };
}

export function parseMiRecord(line: string): MiRecord | null {
    if (!line) {
        return null;
    }
    let pos = 0;
    let token: number | undefined;
    const tokenMatch = /^\d+/.exec(line);
    if (tokenMatch) {
        token = parseInt(tokenMatch[0], 10);
        pos = tokenMatch[0].length;
    }
    const kind = line[pos];
    if (!"^*+=~@&".includes(kind)) {
        return null;
    }
    pos++;
    if (kind === "~" || kind === "@" || kind === "&") {
        const parsed = parseMiValue(line, pos);
        return {
            token,
            kind,
            results: {},
            stream: typeof parsed.value === "string" ? parsed.value : "",
            raw: line,
        };
    }
    let className = "";
    const classStart = pos;
    while (pos < line.length && line[pos] !== ",") {
        pos++;
    }
    className = line.slice(classStart, pos).trim();
    const results: MiTuple = {};
    if (line[pos] === ",") {
        pos++;
    }
    while (pos < line.length) {
        const keyStart = pos;
        while (pos < line.length && line[pos] !== "=" && line[pos] !== ",") {
            pos++;
        }
        const key = line.slice(keyStart, pos).trim();
        if (line[pos] === "=") {
            pos++;
            const parsed = parseMiValue(line, pos);
            if (key) {
                results[key] = parsed.value;
            }
            pos = parsed.pos;
        } else if (key) {
            results[key] = "";
        }
        if (line[pos] === ",") {
            pos++;
        }
    }
    return { token, kind, className, results, raw: line };
}

/** Quote an argument for MI. */
export function miQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function miString(value: MiValue | undefined): string {
    if (value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(miString).join("");
    }
    return "";
}

export function miNumber(value: MiValue | undefined): number {
    const text = miString(value).trim();
    if (!text) {
        return NaN;
    }
    if (/^0x[0-9a-f]+$/i.test(text)) {
        return parseInt(text, 16);
    }
    if (/^-?\d+$/.test(text)) {
        return parseInt(text, 10);
    }
    return NaN;
}

export class GdbMi extends EventEmitter {
    private readonly proc: ChildProcessWithoutNullStreams;
    private buffer = "";
    private nextToken = 1;
    private pending = new Map<number, { resolve: (r: MiRecord) => void; reject: (e: Error) => void }>();
    private closed = false;

    constructor(gdbPath: string, cwd?: string) {
        super();
        this.proc = spawn(gdbPath, ["--interpreter=mi2", "--quiet", "--nx"], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc.stdout.setEncoding("utf8");
        this.proc.stderr.setEncoding("utf8");
        this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
        this.proc.stderr.on("data", (chunk: string) => this.emit("log", chunk));
        this.proc.on("exit", (code, signal) => {
            this.closed = true;
            const err = new Error(`gdb exited (${code ?? signal})`);
            for (const p of this.pending.values()) {
                p.reject(err);
            }
            this.pending.clear();
            this.emit("exit", code, signal);
        });
        this.proc.on("error", (err) => {
            this.closed = true;
            this.emit("log", `${err.message}\n`);
            for (const p of this.pending.values()) {
                p.reject(err);
            }
            this.pending.clear();
            this.emit("exit", -1, null);
        });
    }

    get alive(): boolean {
        return !this.closed;
    }

    /** Send a command and resolve with its `^done`/`^error` result. */
    send(command: string, timeoutMs = 20000): Promise<MiResultRecord> {
        if (this.closed) {
            return Promise.reject(new Error("gdb is not running"));
        }
        const token = this.nextToken++;
        const line = `${token}${command}\n`;
        return new Promise<MiResultRecord>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`gdb command timed out: ${command}`));
            }, timeoutMs);
            this.pending.set(token, {
                resolve: (rec) => {
                    clearTimeout(timer);
                    if (rec.className === "error") {
                        reject(new Error(miString(rec.results.msg) || `gdb error: ${command}`));
                    } else {
                        resolve(rec as MiResultRecord);
                    }
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
            this.proc.stdin.write(line);
        });
    }

    /** Send a command, ignoring errors (for optional setup commands). */
    async trySend(command: string, timeoutMs = 8000): Promise<void> {
        try {
            await this.send(command, timeoutMs);
        } catch {
            // optional
        }
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.proc.stdin.write("-gdb-exit\n");
        } catch {
            // ignore
        }
        const killTimer = setTimeout(() => {
            try {
                this.proc.kill("SIGKILL");
            } catch {
                // ignore
            }
        }, 800);
        killTimer.unref?.();
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        for (;;) {
            const idx = this.buffer.indexOf("\n");
            if (idx < 0) {
                break;
            }
            const line = this.buffer.slice(0, idx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(idx + 1);
            const rec = parseMiRecord(line);
            if (!rec) {
                continue;
            }
            if (rec.token !== undefined && (rec.kind === "^" || rec.kind === "+")) {
                const p = this.pending.get(rec.token);
                if (p) {
                    this.pending.delete(rec.token);
                    if (rec.className === "error") {
                        p.reject(new Error(miString(rec.results.msg) || "gdb error"));
                    } else {
                        p.resolve(rec);
                    }
                }
                continue;
            }
            switch (rec.kind) {
                case "*":
                    if (rec.className === "stopped") {
                        this.emit("stop", rec);
                    } else if (rec.className === "running") {
                        this.emit("running", rec);
                    }
                    break;
                case "=":
                    this.emit("notify", rec);
                    break;
                case "~":
                case "@":
                case "&":
                    this.emit(rec.kind === "~" ? "console" : rec.kind === "@" ? "target" : "log", rec.stream ?? "");
                    break;
                default:
                    break;
            }
        }
    }
}
