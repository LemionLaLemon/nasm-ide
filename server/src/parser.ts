// Document model for NASM source files: labels/constants, doc comments,
// and global/extern declarations.
export type SymbolKind = "label" | "const";

export interface DocParam {
    name: string;
    size: string;
    desc: string;
}

export interface SymbolDoc {
    brief: string[];
    params: DocParam[];
    returns: DocParam[];
}

export interface AsmSymbol {
    name: string;
    kind: SymbolKind;
    line: number;
    character: number;
    doc: SymbolDoc;
}

export interface ExternDecl {
    name: string;
    line: number;
}

export interface DocumentModel {
    symbols: AsmSymbol[];
    globals: string[];
    externs: ExternDecl[];
}

const LABEL_REGEX = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;
const CONST_REGEX = /^\s*([A-Za-z_.$][\w.$]*)\s+equ\b/i;
const GLOBAL_DECL_REGEX = /^\s*(global|extern)\b\s*(.*)$/i;

// A doc line is a `;` comment. Optional decoration (`---`, `--@`, `@`, `;;`)
// is stripped, so all of
//   ; Adds two numbers.
//   ;; Adds two numbers.
//   ;---@param eax first operand
//   ; @param ebx second operand
//   ;---@return eax the sum
// attach to the label below. A `;---...` separator or blank line ends the block.
const DOC_PREFIX_REGEX = /^\s*;\s*(?:---?\s*@|---@?|@)?\s?(.*)$/;
const SEPARATOR_REGEX = /^[-=]{3,}$/;
const PARAM_TAG_REGEX = /^param\s+(\S+)\s*(.*)$/i;
const RETURN_TAG_REGEX = /^returns?\s*(.*)$/i;

// NASM size keywords, usable before or after the name:
//   ; @return byte rax current character
//   ; @param somebuffer 192 bytes str buffer
const SIZE_KEYWORD_REGEX = /^(byte|word|dword|qword|tword|tbyte|oword|yword|zword)$/i;
const SIZE_COUNT_REGEX = /^\d+$/;
const SIZE_UNIT_REGEX = /^bytes?$/i;

export function splitComment(raw: string): { code: string; comment: string | null } {
    let quote: string | null = null;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
        } else if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
        } else if (ch === ";") {
            return { code: raw.slice(0, i), comment: raw.slice(i + 1) };
        }
    }
    return { code: raw, comment: null };
}

function splitEntry(text: string): DocParam | null {
    const toks = text.split(/\s+/).filter((t) => t.length > 0);
    if (toks.length === 0) {
        return null;
    }
    let size = "";
    let i = 0;
    const takeSize = (): boolean => {
        if (i < toks.length && SIZE_KEYWORD_REGEX.test(toks[i])) {
            size = toks[i].toLowerCase();
            i++;
            return true;
        }
        if (i + 1 < toks.length && SIZE_COUNT_REGEX.test(toks[i]) && SIZE_UNIT_REGEX.test(toks[i + 1])) {
            size = `${toks[i]} bytes`;
            i += 2;
            return true;
        }
        return false;
    };
    takeSize();
    let name = "";
    if (i < toks.length) {
        name = toks[i].replace(/:+$/, "");
        if (/^[-:]+$/.test(name)) {
            name = "";
        }
        i++;
    }
    if (!size) {
        takeSize();
    }
    const desc = toks.slice(i).join(" ").replace(/^[-:\s]+/, "");
    return { name, size, desc };
}

function formatEntry(e: DocParam): string {
    let s = e.name ? `\`${e.name}\`` : "";
    if (e.size) {
        s += (s ? " - " : "") + e.size;
    }
    if (e.desc) {
        s += (s ? " - " : "") + e.desc;
    }
    return `- ${s}`;
}

function parseDocLine(content: string, doc: SymbolDoc): void {
    const tag = content.replace(/^@/, "").trim();
    let m = PARAM_TAG_REGEX.exec(tag);
    if (m) {
        const e = splitEntry(`${m[1] || ""} ${m[2] || ""}`);
        if (e) {
            doc.params.push(e);
        }
        return;
    }
    m = RETURN_TAG_REGEX.exec(tag);
    if (m) {
        const e = splitEntry(m[1] || "");
        if (e) {
            doc.returns.push(e);
        }
        return;
    }
    doc.brief.push(content);
}

// Collect the contiguous `;` comment block directly above `symbolLine`.
// `global`/`extern` declaration lines are transparent to the scan; blank
// lines and `;---` separators end it. `trailing` is the `;` comment on the
// symbol line itself (fallback brief).
export function extractDocComment(lines: string[], symbolLine: number, trailing: string): SymbolDoc {
    const doc: SymbolDoc = { brief: [], params: [], returns: [] };
    const block: string[] = [];
    for (let i = symbolLine - 1; i >= 0; i--) {
        const raw = lines[i];
        if (!raw.trim()) {
            break;
        }
        if (/^\s*(global|extern)\b/i.test(splitComment(raw).code)) {
            continue;
        }
        const dm = DOC_PREFIX_REGEX.exec(raw);
        if (!dm) {
            break;
        }
        // Work from the raw remainder so the `@` decoration matcher in
        // DOC_PREFIX_REGEX cannot swallow a bare `---` separator first.
        const afterSemi = raw.replace(/^\s*;\s*/, "").replace(/^;+/, "");
        if (SEPARATOR_REGEX.test(afterSemi.trim())) {
            break;
        }
        const content = afterSemi.replace(/^(?:---?\s*@|---@?|@)\s?/, "").trim();
        if (!content) {
            block.unshift("");
            continue;
        }
        block.unshift(content);
    }
    for (const line of block) {
        parseDocLine(line, doc);
    }
    if (block.length === 0 && trailing) {
        doc.brief.push(trailing);
    }
    return doc;
}

export function renderSymbolDoc(sym: Pick<AsmSymbol, "name" | "kind" | "doc">): string {
    const lines: string[] = [];
    lines.push("```nasm");
    lines.push(sym.kind === "label" ? `${sym.name}:` : sym.name);
    lines.push("```");
    lines.push("");
    const doc = sym.doc;
    const hasDoc =
        doc && (doc.brief.some((l) => l.trim()) || doc.params.length > 0 || doc.returns.length > 0);
    if (!hasDoc) {
        lines.push(sym.kind === "label" ? "Code label." : "Constant defined with `equ`.");
        return lines.join("\n");
    }
    const brief = doc.brief.join("\n").trim();
    if (brief) {
        lines.push(brief);
        lines.push("");
    }
    if (doc.params.length > 0) {
        lines.push("**Parameters**");
        lines.push("");
        for (const p of doc.params) {
            lines.push(formatEntry(p));
        }
        lines.push("");
    }
    if (doc.returns.length > 0) {
        lines.push("**Returns**");
        lines.push("");
        for (const r of doc.returns) {
            lines.push(formatEntry(r));
        }
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseDocument(text: string): DocumentModel {
    const symbols: AsmSymbol[] = [];
    const globals: string[] = [];
    const externs: ExternDecl[] = [];
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const raw = lines[lineIndex];
        const { code, comment } = splitComment(raw);
        if (!code.trim()) {
            continue;
        }
        const declMatch = GLOBAL_DECL_REGEX.exec(code);
        if (declMatch) {
            const isGlobal = declMatch[1].toLowerCase() === "global";
            for (const part of declMatch[2].split(/[,\s]+/)) {
                const clean = part.split(":")[0].trim();
                if (/^[A-Za-z_.$][\w.$]*$/.test(clean)) {
                    if (isGlobal) {
                        globals.push(clean);
                    } else {
                        externs.push({ name: clean, line: lineIndex });
                    }
                }
            }
            continue;
        }
        const trailing = comment ? comment.trim() : "";
        const labelMatch = LABEL_REGEX.exec(code);
        if (labelMatch) {
            const name = labelMatch[1];
            const character = raw.indexOf(name);
            symbols.push({
                name,
                kind: "label",
                line: lineIndex,
                character: character >= 0 ? character : 0,
                doc: extractDocComment(lines, lineIndex, trailing),
            });
            continue;
        }
        const constMatch = CONST_REGEX.exec(code);
        if (constMatch) {
            const name = constMatch[1];
            const character = raw.indexOf(name);
            symbols.push({
                name,
                kind: "const",
                line: lineIndex,
                character: character >= 0 ? character : 0,
                doc: extractDocComment(lines, lineIndex, trailing),
            });
        }
    }
    return { symbols, globals, externs };
}
