// System probing for link libraries: discover linkable `-l` flags,
// resolve a flag to its .so, and read dynamic symbol exports via nm.
// Pure node (no vscode dependency) so it runs in both server and tests.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface LibraryCandidate {
    /** -l flag without prefix, e.g. "c" for -lc */
    flag: string;
    /** Resolved filesystem path, when known */
    path?: string;
    /** Human-readable source, e.g. the ldconfig entry */
    description: string;
}

function execQuiet(file: string, args: string[]): string | null {
    try {
        return execFileSync(file, args, {
            encoding: "utf8",
            timeout: 15000,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return null;
    }
}

function flagFromLibName(lib: string): string | null {
    // libXft.so.2 -> Xft ; libfoo.so -> foo
    const m = /^lib(.+?)(?:\.so.*|\.a)?$/.exec(lib);
    if (!m) {
        return null;
    }
    const base = m[1].split(".")[0];
    return base.length > 0 ? base : null;
}

/** Parse `ldconfig -p` into soname -> path, preferring the host architecture.
 *  Multilib systems list 32-bit entries after the native ones, so a plain
 *  Map.set would let /usr/lib32 overwrite /usr/lib. */
export function ldconfigMap(): Map<string, string> {
    const out = new Map<string, string>();
    const scores = new Map<string, number>();
    const text = execQuiet("ldconfig", ["-p"]);
    if (!text) {
        return out;
    }
    for (const line of text.split("\n")) {
        const m = /^\s*(\S+)\s+\(([^)]*)\)\s+=>\s+(\S+)\s*$/.exec(line);
        if (!m) {
            continue;
        }
        const [, name, tag, p] = m;
        const score = ldconfigScore(tag, p);
        const prev = scores.get(name);
        if (prev === undefined || score > prev) {
            out.set(name, p);
            scores.set(name, score);
        }
    }
    return out;
}

const NATIVE_TAGS: Record<string, RegExp> = {
    x64: /x86-64|x86_64/,
    arm64: /aarch64|arm64/,
    ia32: /i[3-6]86/,
    arm: /arm/,
    ppc64: /ppc64/,
    s390x: /s390x/,
    riscv64: /riscv64/,
    loong64: /loong/,
};

function ldconfigScore(tag: string, p: string): number {
    const native = NATIVE_TAGS[process.arch];
    const host64 = process.arch === "x64" || process.arch.endsWith("64");
    let score = 0;
    const is32Path = /(^|\/)(lib32|libx32|i[3-6]86-linux-gnu)\//.test(p);
    const is32Tag = /\bi[3-6]86\b/.test(tag);
    if ((is32Path || is32Tag) && host64) {
        score -= 100;
    }
    if (native && native.test(tag)) {
        score += 10;
    }
    if (p.startsWith("/usr/lib/") || p.startsWith("/lib/")) {
        score += 1;
    }
    return score;
}

/** Directories the system linker searches, from gcc plus common defaults. */
export function linkerSearchDirs(): string[] {
    const dirs: string[] = [];
    const seen = new Set<string>();
    const push = (d: string): void => {
        if (d && !seen.has(d)) {
            seen.add(d);
            dirs.push(d);
        }
    };
    const text = execQuiet("gcc", ["-print-search-dirs"]);
    if (text) {
        for (const line of text.split("\n")) {
            if (line.startsWith("libraries: =")) {
                for (const part of line.slice("libraries: =".length).split(":")) {
                    try {
                        if (fs.existsSync(part)) {
                            push(fs.realpathSync(part));
                        }
                    } catch {
                        // ignore unreadable entries
                    }
                }
            }
        }
    }
    for (const d of ["/usr/lib", "/usr/local/lib", "/lib", "/usr/lib64", "/lib64"]) {
        try {
            if (fs.existsSync(d)) {
                push(fs.realpathSync(d));
            }
        } catch {
            // ignore
        }
    }
    return dirs;
}

function pathArchScore(p: string): number {
    let score = 0;
    if (/(^|\/)(lib32|libx32|i[3-6]86-linux-gnu)\//.test(p)) {
        score -= 100;
    }
    if (p.startsWith("/usr/lib/") || p.startsWith("/lib/")) {
        score += 1;
    }
    return score;
}

/**
 * Resolve a `-l` flag (without prefix) to a linkable file.
 * Prefers the ldconfig dev symlink (libfoo.so), then search directories.
 */
export function resolveLibrary(flag: string): string | null {
    const dev = `lib${flag}.so`;
    const cache = ldconfigMap();
    let best: string | null = null;
    let bestScore = -Infinity;
    const consider = (p: string): void => {
        const score = pathArchScore(p);
        if (score > bestScore) {
            best = p;
            bestScore = score;
        }
    };
    const exact = cache.get(dev);
    if (exact) {
        consider(exact);
    }
    // Any versioned entry proves the flag exists; prefer native over multilib.
    for (const [name, p] of cache) {
        if (name === dev || name.startsWith(`${dev}.`)) {
            consider(p);
        }
    }
    if (best) {
        return best;
    }
    for (const dir of linkerSearchDirs()) {
        for (const cand of [`lib${flag}.so`, `lib${flag}.a`]) {
            const full = path.join(dir, cand);
            try {
                if (fs.statSync(full).isFile()) {
                    return full;
                }
            } catch {
                // try next
            }
        }
    }
    return null;
}

/** Follow a GNU ld script (e.g. libncurses.so -> INPUT(-lncursesw)) and
 *  return the referenced files. Returns null when the file is not a script. */
function ldScriptRefs(file: string): string[] | null {
    let text: string;
    try {
        if (fs.statSync(file).size > 512 * 1024) {
            return null;
        }
        text = fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
    // ELF binaries contain NUL bytes; scripts are plain text.
    if (text.includes("\u0000") || !/GNU ld script|^\s*(?:INPUT|GROUP)\s*\(/m.test(text)) {
        return null;
    }
    text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    const refs: string[] = [];
    for (const m of text.matchAll(/-l\s*([\w.+-]+)/g)) {
        const resolved = resolveLibrary(m[1]);
        if (resolved) {
            refs.push(resolved);
        }
    }
    for (const m of text.matchAll(/(?:^|[\s(])((?:\/|lib)[^\s()]+\.(?:so(?:\.\d+)*|a))(?=[\s)]|$)/g)) {
        const raw = m[1];
        if (raw.startsWith("/")) {
            try {
                if (fs.statSync(raw).isFile()) {
                    refs.push(raw);
                }
            } catch {
                // referenced path missing
            }
            continue;
        }
        for (const dir of linkerSearchDirs()) {
            const full = path.join(dir, raw);
            try {
                if (fs.statSync(full).isFile()) {
                    refs.push(full);
                    break;
                }
            } catch {
                // try next dir
            }
        }
    }
    return refs;
}

function nmFile(file: string, visited: Set<string>, depth: number): Set<string> {
    const out = new Set<string>();
    let real = file;
    try {
        real = fs.realpathSync(file);
    } catch {
        // keep the given path
    }
    if (depth > 4 || visited.has(real)) {
        return out;
    }
    visited.add(real);
    const refs = ldScriptRefs(real);
    if (refs) {
        for (const ref of refs) {
            for (const sym of nmFile(ref, visited, depth + 1)) {
                out.add(sym);
            }
        }
        return out;
    }
    const isArchive = /\.a$/.test(real.toLowerCase());
    const text = execQuiet("nm", isArchive ? ["--defined-only", real] : ["-D", "--defined-only", real]);
    if (!text) {
        return out;
    }
    for (const line of text.split("\n")) {
        const m = /^[0-9a-fA-F]+\s+[A-Za-z?]\s+(\S+)\s*$/.exec(line.trim());
        if (m) {
            out.add(m[1].split("@")[0]);
        }
    }
    return out;
}

/** Defined symbols of a linkable file, following GNU ld scripts. */
export function nmDefinedSymbols(soPath: string): Set<string> {
    return nmFile(soPath, new Set(), 0);
}

/**
 * Every linkable `-l` flag found on this system, deduplicated and sorted.
 * Backing data: ldconfig entries plus lib*.so* files in linker search dirs.
 */
export function listLibraryCandidates(): LibraryCandidate[] {
    const byFlag = new Map<string, LibraryCandidate>();
    const cache = ldconfigMap();
    for (const [name, p] of cache) {
        if (!name.includes(".so")) {
            continue;
        }
        const flag = flagFromLibName(name);
        if (!flag || byFlag.has(flag)) {
            continue;
        }
        byFlag.set(flag, { flag, path: p, description: p });
    }
    for (const dir of linkerSearchDirs()) {
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of entries) {
            if (!name.startsWith("lib") || !name.includes(".so")) {
                continue;
            }
            const flag = flagFromLibName(name);
            if (!flag || byFlag.has(flag)) {
                continue;
            }
            const full = path.join(dir, name);
            byFlag.set(flag, { flag, path: full, description: full });
        }
    }
    return [...byFlag.values()].sort((a, b) => (a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0));
}
