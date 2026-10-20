// Stack balance + FILO pairing with a tiny intra-function CFG.
//
// Segments are delimited by non-local labels. Inside a segment we cut basic
// blocks at labels and after `ret`/`jmp`/`jcc`, resolve direct jump targets
// (including local `.labels`) and propagate the *minimum* incoming stack
// depth along real edges. Pops are judged against that minimum, so code like
//
//     jc .failed
//     pop rbx
//     pop rbp
//     ret
// .failed:
//     pop rbx        ; valid: the jc path never executed the pops above
//     pop rbp
//     ret
//
// is no longer flagged. Diagnostics:
//   - pop with a provably too-small stack on every path to it -> Error
//   - `ret` (or tail `jmp` out) with pushes left on every path -> Error
//   - the pushes left over get "push without a matching pop" Errors
//
// It is still a heuristic, not a verifier: joins take the shallowest path, so
// genuinely conflicting paths are reported conservatively. Disable with
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

const CONDITIONAL_JUMPS = new Set([
    "ja",
    "jae",
    "jb",
    "jbe",
    "jc",
    "je",
    "jg",
    "jge",
    "jl",
    "jle",
    "jna",
    "jnae",
    "jnb",
    "jnbe",
    "jnc",
    "jne",
    "jng",
    "jnge",
    "jnl",
    "jnle",
    "jno",
    "jnp",
    "jns",
    "jnz",
    "jo",
    "jp",
    "jpe",
    "jpo",
    "js",
    "jz",
    "jecxz",
    "jrcxz",
    "loop",
    "loope",
    "loopne",
    "loopnz",
    "loopz",
]);

function firstToken(raw: string): string {
    const { code } = splitComment(raw);
    const m = /^\s*([A-Za-z_.$][\w.$]*)/.exec(code);
    return m ? m[1].toLowerCase() : "";
}

/** Offset and length of the leading word (mnemonic position for tokens). */
export function leadingWord(raw: string): { character: number; length: number } | null {
    const { code } = splitComment(raw);
    const m = /^(\s*)([A-Za-z_.$][\w.$]*)/.exec(code);
    if (!m) {
        return null;
    }
    return { character: m[1].length, length: m[2].length };
}

interface Instruction {
    tok: string;
    rest: string;
}

function instructionAt(raw: string): Instruction | null {
    const { code } = splitComment(raw);
    const m = /^\s*([A-Za-z_.$][\w.$]*)\b(.*)$/.exec(code);
    if (!m) {
        return null;
    }
    return { tok: m[1].toLowerCase(), rest: m[2] };
}

/** Line numbers (ascending) that start new function segments. */
export function runBoundaries(lines: string[], model: DocumentModel): number[] {
    const bounds = new Set<number>([0, lines.length]);
    for (const sym of model.symbols) {
        if (sym.kind === "label" && !sym.name.startsWith(".")) {
            bounds.add(sym.line);
        }
    }
    return [...bounds].sort((a, b) => a - b);
}

type Terminator =
    | { kind: "ret" }
    | { kind: "jmp"; target: string | null }
    | { kind: "jcc"; target: string | null };

function jumpTarget(rest: string): string | null {
    let t = rest.trim();
    if (!t) {
        return null;
    }
    const hint = /^(?:short|near|far|byte|word|dword|qword)\s+(.*)$/i.exec(t);
    if (hint) {
        t = hint[1].trim();
    }
    const m = /^([A-Za-z_.$][\w.$]*)/.exec(t);
    // Indirect or expression targets (`[rax]`, `rax + 8`, ...) stay unresolved.
    return m ? m[1] : null;
}

function classifyTerminator(ins: Instruction): Terminator | null {
    const tok = ins.tok;
    if (tok === "ret" || tok === "retn" || tok === "retf") {
        return { kind: "ret" };
    }
    if (tok === "jmp") {
        return { kind: "jmp", target: jumpTarget(ins.rest) };
    }
    if (CONDITIONAL_JUMPS.has(tok)) {
        return { kind: "jcc", target: jumpTarget(ins.rest) };
    }
    return null;
}

interface Block {
    /** First line of the block. */
    start: number;
    /** Exclusive end; next block start or segment end. */
    end: number;
    term: Terminator | null;
    termLine: number;
}

/** One stack slot. `pair` is the push's FILO color index. */
interface Slot {
    line: number;
    pair: number;
}

interface PopPair {
    line: number;
    pair: number;
}

interface Simulation {
    exit: Slot[];
    popPairs: PopPair[];
    consumed: number[];
    deficits: Array<{ line: number; have: number; need: number }>;
}

function simulateBlock(
    lines: string[],
    block: Block,
    entry: Slot[],
    pushOrder: Map<number, number>
): Simulation {
    const stack = entry.slice();
    const sim: Simulation = { exit: stack, popPairs: [], consumed: [], deficits: [] };
    for (let i = block.start; i < block.end; i++) {
        const ins = instructionAt(lines[i]);
        if (!ins) {
            continue;
        }
        const push = PUSH_SLOTS[ins.tok];
        if (push !== undefined) {
            const pair = pushOrder.get(i);
            for (let k = 0; k < push; k++) {
                stack.push({ line: i, pair: pair ?? 0 });
            }
            continue;
        }
        const pop = POP_SLOTS[ins.tok];
        if (pop === undefined) {
            continue;
        }
        if (stack.length < pop) {
            sim.deficits.push({ line: i, have: stack.length, need: pop });
            continue;
        }
        const popped = stack.splice(stack.length - pop, pop);
        for (const slot of popped) {
            sim.consumed.push(slot.line);
        }
        sim.popPairs.push({ line: i, pair: popped[popped.length - 1].pair });
    }
    return sim;
}

interface SegmentResult {
    issues: StackIssue[];
    popPairs: Map<number, number>;
    pushOrder: Map<number, number>;
}

function analyzeSegment(
    lines: string[],
    model: DocumentModel,
    start: number,
    end: number
): SegmentResult {
    const labelMap = new Map<string, number>();
    const labelLines = new Set<number>();
    for (const sym of model.symbols) {
        if (sym.kind === "label" && sym.line >= start && sym.line < end) {
            const key = sym.name.toLowerCase();
            if (!labelMap.has(key)) {
                labelMap.set(key, sym.line);
            }
            labelLines.add(sym.line);
        }
    }

    // Assign FILO colors in textual order so colors stay stable regardless of
    // the order blocks happen to be visited by the dataflow.
    const pushOrder = new Map<number, number>();
    let nextPair = 0;
    for (let i = start; i < end; i++) {
        const ins = instructionAt(lines[i]);
        if (ins && PUSH_SLOTS[ins.tok] !== undefined) {
            pushOrder.set(i, nextPair++);
        }
    }

    const starts = new Set<number>([start]);
    for (let i = start; i < end; i++) {
        if (labelLines.has(i)) {
            starts.add(i);
        }
        const ins = instructionAt(lines[i]);
        if (ins && classifyTerminator(ins) && i + 1 < end) {
            starts.add(i + 1);
        }
    }

    const ordered = [...starts].sort((a, b) => a - b);
    const blocks: Block[] = [];
    for (let k = 0; k < ordered.length; k++) {
        const bs = ordered[k];
        const be = k + 1 < ordered.length ? ordered[k + 1] : end;
        let term: Terminator | null = null;
        let termLine = be - 1;
        for (let i = bs; i < be; i++) {
            const ins = instructionAt(lines[i]);
            if (!ins) {
                continue;
            }
            const t = classifyTerminator(ins);
            if (t) {
                term = t;
                termLine = i;
            }
        }
        blocks.push({ start: bs, end: be, term, termLine });
    }

    const successors = (block: Block): number[] => {
        const out: number[] = [];
        if (!block.term) {
            if (block.end < end) {
                out.push(block.end);
            }
            return out;
        }
        if (block.term.kind === "ret") {
            return out;
        }
        const target = block.term.target
            ? labelMap.get(block.term.target.toLowerCase())
            : undefined;
        if (block.term.kind === "jmp") {
            if (target !== undefined) {
                out.push(target);
            }
            return out;
        }
        if (target !== undefined) {
            out.push(target);
        }
        if (block.end < end) {
            out.push(block.end);
        }
        return out;
    };

    // Forward dataflow keeping only the shallowest known entry stack. Depth is
    // what matters for diagnostics; the representative stack supplies colors.
    const entry = new Map<number, Slot[]>();
    if (blocks.length > 0) {
        entry.set(blocks[0].start, []);
    }
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 500) {
        changed = false;
        for (const block of blocks) {
            const incoming = entry.get(block.start);
            if (!incoming) {
                continue;
            }
            const sim = simulateBlock(lines, block, incoming, pushOrder);
            for (const succ of successors(block)) {
                const current = entry.get(succ);
                if (!current || sim.exit.length < current.length) {
                    entry.set(succ, sim.exit);
                    changed = true;
                }
            }
        }
    }

    const issues: StackIssue[] = [];
    const errorLines = new Set<number>();
    const err = (line: number, message: string): void => {
        if (errorLines.has(line)) {
            return;
        }
        errorLines.add(line);
        issues.push({ line, message });
    };
    const popPairs = new Map<number, number>();

    for (const block of blocks) {
        const incoming = entry.get(block.start);
        if (!incoming) {
            continue; // unreachable code (e.g. after a tail jmp)
        }
        const sim = simulateBlock(lines, block, incoming, pushOrder);
        for (const deficit of sim.deficits) {
            err(deficit.line, "pop without a matching push on this path");
        }
        for (const pair of sim.popPairs) {
            popPairs.set(pair.line, pair.pair);
        }

        const depth = sim.exit.length;
        if (depth === 0) {
            continue;
        }
        // Code falls off the end of the segment, returns, or tail-jumps to an
        // unknown destination: that path leaves pushes behind.
        const endsHere =
            block.term === null
                ? block.end >= end
                : block.term.kind === "ret" ||
                  (block.term.kind === "jmp" && successors(block).length === 0);
        if (!endsHere) {
            continue;
        }
        if (block.term && block.term.kind === "ret") {
            err(
                block.termLine,
                `unbalanced stack at ret: ${depth} pushed slot(s) never popped on this path`
            );
        }
        for (const slot of sim.exit) {
            err(slot.line, "push without a matching pop in this function");
        }
    }

    return { issues, popPairs, pushOrder };
}

function analyzeText(text: string, model: DocumentModel): SegmentResult[] {
    const lines = text.split(/\r?\n/);
    const bounds = runBoundaries(lines, model);
    const results: SegmentResult[] = [];
    for (let s = 0; s < bounds.length - 1; s++) {
        results.push(analyzeSegment(lines, model, bounds[s], bounds[s + 1]));
    }
    return results;
}

export interface PairToken {
    line: number;
    character: number;
    length: number;
    /** Nesting depth color index; render as pair{index % 6}. */
    pair: number;
}

/** FILO pair coloring, using the same CFG-aware matching as diagnostics. */
export function pairPushPop(text: string, model: DocumentModel): PairToken[] {
    const lines = text.split(/\r?\n/);
    const out: PairToken[] = [];
    for (const result of analyzeText(text, model)) {
        const byLine = new Map<number, number>();
        for (const [line, pair] of result.pushOrder) {
            byLine.set(line, pair);
        }
        for (const [line, pair] of result.popPairs) {
            byLine.set(line, pair);
        }
        for (const [line, pair] of byLine) {
            const pos = leadingWord(lines[line]);
            if (pos) {
                out.push({ line, character: pos.character, length: pos.length, pair });
            }
        }
    }
    return out;
}

export function analyzeStack(text: string, model: DocumentModel): StackIssue[] {
    const out: StackIssue[] = [];
    const seen = new Set<number>();
    for (const result of analyzeText(text, model)) {
        for (const issue of result.issues) {
            if (seen.has(issue.line)) {
                continue;
            }
            seen.add(issue.line);
            out.push(issue);
        }
    }
    return out;
}
