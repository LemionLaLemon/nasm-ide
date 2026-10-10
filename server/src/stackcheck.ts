// Straight-line + linear-LIFO stack balance analysis.
//
// Model: `push` adds slots, `pop` removes them. Diagnostics:
//   - pop with provably empty stack on the function-entry path -> Error
//   - `ret` with pushes never popped on the entry path -> Error
//   - pushes/pops left unmatched by whole-function linear LIFO pairing ->
//     Error on the specific line ("no matching pop/push").
//
// Limits (by design, documented in README): branchy functions where a push
// on one path pairs with a pop on another can warn on correct code. This is
// a pairing heuristic, not dataflow analysis; disable per-workspace with
// nasmIde.diagnostics.stackCheck.
import { splitComment } from "./parser";
import { DocumentModel } from "./parser";

export interface StackIssue {
    line: number;
    message: string;
}

const PUSH_SLOTS: Record<string, number> = {
    push: 1,
    pushf: 1,
    pushfd: 1,
    pushfq: 1,
    pusha: 8,
    pushad: 8,
};

const POP_SLOTS: Record<string, number> = {
    pop: 1,
    popf: 1,
    popfd: 1,
    popfq: 1,
    popa: 8,
    popad: 8,
};

function firstToken(raw: string): string {
    const { code } = splitComment(raw);
    const m = /^\s*([A-Za-z_.$][\w.$]*)/.exec(code);
    return m ? m[1].toLowerCase() : "";
}

/** Line numbers (ascending) that start new straight-line runs. */
function runBoundaries(lines: string[], model: DocumentModel): number[] {
    const bounds = new Set<number>([0, lines.length]);
    for (const sym of model.symbols) {
        if (sym.kind === "label" && !sym.name.startsWith(".")) {
            bounds.add(sym.line);
        }
    }
    return [...bounds].sort((a, b) => a - b);
}

function isRet(tok: string): boolean {
    return tok === "ret";
}

function isUnconditionalJump(tok: string): boolean {
    return tok === "jmp";
}

export function analyzeStack(text: string, model: DocumentModel): StackIssue[] {
    const issues: StackIssue[] = [];
    const errorLines = new Set<number>();
    const err = (line: number, message: string): void => {
        issues.push({ line, message });
        errorLines.add(line);
    };
    const lines = text.split(/\r?\n/);
    const bounds = runBoundaries(lines, model);

    // Function segments: [bound[i], bound[i+1]) for segments starting at a
    // non-local label (or BOF). Straight-line entry run within each segment.
    for (let s = 0; s < bounds.length - 1; s++) {
        const start = bounds[s];
        const end = bounds[s + 1];
        let depth = 0;
        for (let i = start; i < end; i++) {
            const tok = firstToken(lines[i]);
            if (!tok) {
                continue;
            }
            if (isRet(tok) || isUnconditionalJump(tok)) {
                if (isRet(tok) && depth > 0) {
                    err(i, `unbalanced stack at ret: ${depth} pushed slot(s) never popped on this path`);
                }
                break;
            }
            if (tok in PUSH_SLOTS) {
                depth += PUSH_SLOTS[tok];
            } else if (tok in POP_SLOTS) {
                if (depth < POP_SLOTS[tok]) {
                    err(i, `pop without a matching push on this path`);
                } else {
                    depth -= POP_SLOTS[tok];
                }
            }
        }
    }

    // Whole-function linear LIFO pairing across each segment.
    for (let s = 0; s < bounds.length - 1; s++) {
        const start = bounds[s];
        const end = bounds[s + 1];
        const open: number[] = [];
        for (let i = start; i < end; i++) {
            const tok = firstToken(lines[i]);
            if (tok in PUSH_SLOTS) {
                open.push(i);
            } else if (tok in POP_SLOTS) {
                if (open.length === 0) {
                    if (!errorLines.has(i)) {
                        err(i, `pop without a matching push in this function`);
                    }
                } else {
                    open.pop();
                }
            }
        }
        for (const line of open) {
            if (!errorLines.has(line)) {
                err(line, `push without a matching pop in this function`);
            }
        }
    }
    return issues;
}
