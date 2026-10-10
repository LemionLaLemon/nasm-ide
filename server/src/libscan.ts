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

/** Parse `ldconfig -p` into soname -> path. */
export function ldconfigMap(): Map<string, string> {
    const out = new Map<string, string>();
    const text = execQuiet("ldconfig", ["-p"]);
    if (!text) {
        return out;
    }
    for (const line of text.split("\n")) {
        const m = /^\s*(\S+)\s+\([^)]*\)\s+=>\s+(\S+)\s*$/.exec(line);
        if (m) {
            out.set(m[1], m[2]);
        }
    }
    return out;
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

/**
 * Resolve a `-l` flag (without prefix) to a linkable file.
 * Prefers the ldconfig dev symlink (libfoo.so), then search directories.
 */
export function resolveLibrary(flag: string): string | null {
    const dev = `lib${flag}.so`;
    const cache = ldconfigMap();
    if (cache.has(dev)) {
        return cache.get(dev) as string;
    }
    // Any versioned entry proves the flag exists; still prefer a real .so.
    for (const [name, p] of cache) {
        if (name === dev || name.startsWith(`${dev}.`)) {
            return p;
        }
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

/** Defined dynamic symbols of a shared object (version suffixes stripped). */
export function nmDefinedSymbols(soPath: string): Set<string> {
    const out = new Set<string>();
    const text = execQuiet("nm", ["-D", "--defined-only", soPath]);
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
