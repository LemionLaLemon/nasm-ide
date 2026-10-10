// Index of symbols exported by the configured link libraries.
// Rebuilt when the library list changes; lookups are O(1) per keystroke.
import { nmDefinedSymbols, resolveLibrary } from "./libscan";

export class LibraryIndex {
    private key = "";
    private exports = new Set<string>();
    private resolved = new Map<string, string>();

    /** Rebuild if the flag list changed. Returns true when rebuilt. */
    ensure(flags: string[]): boolean {
        const key = JSON.stringify([...flags].sort());
        if (key === this.key) {
            return false;
        }
        this.key = key;
        this.exports = new Set<string>();
        this.resolved = new Map<string, string>();
        for (const flag of flags) {
            const soPath = resolveLibrary(flag);
            if (!soPath) {
                continue;
            }
            this.resolved.set(flag, soPath);
            for (const sym of nmDefinedSymbols(soPath)) {
                this.exports.add(sym.toLowerCase());
            }
        }
        return true;
    }

    provides(symbol: string): boolean {
        return this.exports.has(symbol.toLowerCase());
    }

    resolvedPath(flag: string): string | undefined {
        return this.resolved.get(flag);
    }

    get size(): number {
        return this.exports.size;
    }
}
