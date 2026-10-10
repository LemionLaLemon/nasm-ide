// Index of symbols exported by the configured link libraries.
// Rebuilt when the library list changes; lookups are O(1) per keystroke.
import { nmDefinedSymbols, resolveLibrary } from "./libscan";

export class LibraryIndex {
    private key = "";
    private exports = new Set<string>();
    private perLib = new Map<string, Set<string>>();
    private resolved = new Map<string, string>();

    /** Rebuild if the flag list changed. Returns true when rebuilt. */
    ensure(flags: string[]): boolean {
        const key = JSON.stringify([...flags].sort());
        if (key === this.key) {
            return false;
        }
        this.key = key;
        this.exports = new Set<string>();
        this.perLib = new Map<string, Set<string>>();
        this.resolved = new Map<string, string>();
        for (const flag of flags) {
            const soPath = resolveLibrary(flag);
            const set = new Set<string>();
            if (soPath) {
                this.resolved.set(flag, soPath);
                for (const sym of nmDefinedSymbols(soPath)) {
                    const lower = sym.toLowerCase();
                    this.exports.add(lower);
                    set.add(lower);
                }
            }
            this.perLib.set(flag, set);
        }
        return true;
    }

    provides(symbol: string): boolean {
        return this.exports.has(symbol.toLowerCase());
    }

    /** True when this specific flag's library exports the symbol. */
    providesIn(flag: string, symbol: string): boolean {
        return this.perLib.get(flag)?.has(symbol.toLowerCase()) ?? false;
    }

    resolvedPath(flag: string): string | undefined {
        return this.resolved.get(flag);
    }

    get size(): number {
        return this.exports.size;
    }
}
