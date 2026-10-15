// NASM IDE language server: completions, hover docs, goto-definition,
// nasm diagnostics, cross-file extern index, and library-aware warnings.
import {
    CompletionItem,
    CompletionItemKind,
    createConnection,
    Definition,
    Diagnostic,
    DiagnosticSeverity,
    DidChangeConfigurationNotification,
    Hover,
    InitializeParams,
    InitializeResult,
    Location,
    MarkupKind,
    ProposedFeatures,
    TextDocumentSyncKind,
    TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    getDirective,
    getDirectiveCompletions,
    getInstruction,
    getInstructionCompletions,
    getRegister,
    getRegisterCompletions,
} from "./nasmData";
import { DocumentModel, StrucDef, StrucMember, SymbolKind, parseDocument, renderSymbolDoc, strucSizeBrief } from "./parser";
import { getLibcCompletions, getLibcFunction, renderLibcFunction } from "./libcData";
import { LibraryIndex } from "./libraries";
import { listLibraryCandidates } from "./libscan";
import { buildHeaderIndex, HeaderFunction, manSummary, renderHeaderFunction } from "./headerdocs";
import { analyzeStack, pairPushPop } from "./stackcheck";

interface DiagnosticsSettings {
    enable: boolean;
    mode: "asYouType" | "onSave";
    debounceMs: number;
    unresolvedExterns: boolean;
    stackCheck: boolean;
}

interface NasmIdeSettings {
    nasmPath: string;
    arch: "x86" | "x86_64";
    diagnostics: DiagnosticsSettings;
    libraries: string[];
}

const defaultSettings: NasmIdeSettings = {
    nasmPath: "nasm",
    arch: "x86_64",
    diagnostics: { enable: true, mode: "asYouType", debounceMs: 400, unresolvedExterns: true, stackCheck: true },
    libraries: ["c"],
};

interface IndexEntry {
    name: string;
    uri: string;
    line: number;
    character: number;
    kind: SymbolKind;
    doc: DocumentModel["symbols"][number]["doc"];
    detail?: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let globalSettings: NasmIdeSettings = defaultSettings;
let activeSettings: NasmIdeSettings = defaultSettings;
const documentSettings = new Map<string, Thenable<NasmIdeSettings>>();
const documentModels = new Map<string, DocumentModel>();
const nasmDiagnosticsCache = new Map<string, Diagnostic[]>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
let workspaceRoot: string | null = null;
const workspaceIndex = new Map<string, IndexEntry[]>();
const libraryIndex = new LibraryIndex();
let headerIndexKey = "";
let headerFunctions = new Map<string, HeaderFunction[]>();

function applySettings(settings: NasmIdeSettings): void {
    // Clients may send partial sections (e.g. older versions unaware of new
    // keys); fill gaps from defaults so a missing flag can't silently flip
    // a feature off.
    activeSettings = {
        ...defaultSettings,
        ...settings,
        diagnostics: { ...defaultSettings.diagnostics, ...(settings.diagnostics || {}) },
        libraries: settings.libraries ?? defaultSettings.libraries,
    };
    libraryIndex.ensure(activeSettings.libraries);
    ensureHeaderIndex(activeSettings.libraries);
}

function ensureHeaderIndex(flags: string[]): void {
    const key = JSON.stringify([...flags].sort());
    if (key === headerIndexKey) {
        return;
    }
    headerIndexKey = key;
    headerFunctions = buildHeaderIndex(flags, (flag, name) => libraryIndex.providesIn(flag, name)).functions;
}

function headerDocValue(fn: HeaderFunction): string {
    const summary = fn.summary || manSummary(fn.name) || "No description found in headers or man pages.";
    return renderHeaderFunction(fn, summary);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    if (params.rootUri) {
        try {
            workspaceRoot = fileUriToPath(params.rootUri);
        } catch {
            workspaceRoot = null;
        }
    }
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: [" ", "\t", "%", "[", "."],
            },
            hoverProvider: true,
            definitionProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: ["keyword"],
                    tokenModifiers: ["pair0", "pair1", "pair2", "pair3", "pair4", "pair5"],
                },
                full: true,
            },
        },
    };
    refreshWorkspaceIndex();
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
});

connection.onDidChangeConfiguration(async (change) => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
        // Re-fetch immediately: library changes (e.g. from the picker) must
        // rebuild the nm/header indexes NOW so hover, completion, and
        // diagnostics pick them up without a reload or a keystroke.
        const docs = documents.all();
        if (docs.length > 0) {
            try {
                applySettings(await getDocumentSettings(docs[0].uri));
            } catch {
                // keep previous settings if the client won't answer
            }
        }
    } else {
        globalSettings = (change.settings.nasmIde as NasmIdeSettings) || defaultSettings;
        applySettings(globalSettings);
    }
    for (const doc of documents.all()) {
        publishMergedDiagnostics(doc);
    }
});

connection.onRequest("nasmIde/listLibraryCandidates", () => {
    return listLibraryCandidates();
});

connection.onDidChangeWatchedFiles(() => {
    refreshWorkspaceIndex();
    for (const doc of documents.all()) {
        publishMergedDiagnostics(doc);
    }
});

function getDocumentSettings(resource: string): Thenable<NasmIdeSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: "nasmIde",
        }) as Thenable<NasmIdeSettings>;
        documentSettings.set(resource, result);
    }
    return result;
}

documents.onDidClose((e) => {
    documentSettings.delete(e.document.uri);
    documentModels.delete(e.document.uri);
    nasmDiagnosticsCache.delete(e.document.uri);
    const timer = debounceTimers.get(e.document.uri);
    if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(e.document.uri);
    }
    refreshFileInIndex(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.onDidOpen((e) => {
    updateDocumentModel(e.document);
    refreshFileInIndex(e.document.uri, e.document.getText());
    publishMergedDiagnostics(e.document);
    scheduleValidation(e.document);
});

documents.onDidChangeContent((change) => {
    updateDocumentModel(change.document);
    refreshFileInIndex(change.document.uri, change.document.getText());
    publishMergedDiagnostics(change.document);
    scheduleValidation(change.document);
});

documents.onDidSave((change) => {
    refreshFileInIndex(change.document.uri, change.document.getText());
    void validateTextDocument(change.document, true);
    for (const doc of documents.all()) {
        if (doc.uri !== change.document.uri) {
            publishMergedDiagnostics(doc);
        }
    }
});

function updateDocumentModel(doc: TextDocument): void {
    documentModels.set(doc.uri, parseDocument(doc.getText()));
}

function scheduleValidation(doc: TextDocument): void {
    if (!activeSettings.diagnostics.enable || activeSettings.diagnostics.mode !== "asYouType") {
        return;
    }
    const existing = debounceTimers.get(doc.uri);
    if (existing) {
        clearTimeout(existing);
    }
    const delay = Math.max(0, activeSettings.diagnostics.debounceMs);
    debounceTimers.set(
        doc.uri,
        setTimeout(() => {
            debounceTimers.delete(doc.uri);
            void validateTextDocument(doc);
        }, delay)
    );
}

async function validateTextDocument(textDocument: TextDocument, fromSave = false): Promise<void> {
    const settings = await getDocumentSettings(textDocument.uri);
    applySettings(settings);
    if (!settings.diagnostics.enable) {
        nasmDiagnosticsCache.set(textDocument.uri, []);
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }
    if (settings.diagnostics.mode === "onSave" && !fromSave) {
        return;
    }
    const text = textDocument.getText();
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `nasm-ide-${Date.now()}-${Math.random().toString(36).slice(2)}.asm`);
    try {
        fs.writeFileSync(tmpFile, text, "utf8");
    } catch (err) {
        connection.console.error(`Failed to write temp file for NASM: ${String(err)}`);
        return;
    }
    const isWin = process.platform === "win32";
    const nullDevice = isWin ? "NUL" : "/dev/null";
    const format = settings.arch === "x86_64" ? "elf64" : "elf32";
    const args = ["-f", format, "-o", nullDevice, tmpFile];
    execFile(settings.nasmPath || "nasm", args, (error, _stdout, stderr) => {
        const diagnostics: Diagnostic[] = [];
        if (stderr) {
            const lines = (stderr as string).split(/\r?\n/);
            for (const line of lines) {
                const match = /:(\d+):\s*(error|warning):\s*(.*)$/i.exec(line);
                if (!match) {
                    continue;
                }
                const lineNum = parseInt(match[1], 10) - 1;
                const severityText = match[2].toLowerCase();
                diagnostics.push({
                    range: {
                        start: { line: lineNum, character: 0 },
                        end: { line: lineNum, character: Number.MAX_SAFE_INTEGER },
                    },
                    message: match[3].trim(),
                    severity:
                        severityText === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
                    source: "nasm",
                });
            }
        }
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            connection.window.showWarningMessage(
                "NASM IDE: 'nasm' executable not found. Install NASM or configure nasmIde.nasmPath."
            );
        }
        try {
            fs.unlinkSync(tmpFile);
        } catch {
            // ignore
        }
        nasmDiagnosticsCache.set(textDocument.uri, diagnostics);
        connection.sendDiagnostics({
            uri: textDocument.uri,
            diagnostics: [...diagnostics, ...getWorkspaceDiagnostics(textDocument)],
        });
    });
}

connection.onCompletion((params): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }
    const position = params.position;
    const offset = document.offsetAt(position);
    const text = document.getText();
    const wordRange = getWordRangeAt(text, offset);
    const prefix = wordRange ? text.slice(wordRange.start, wordRange.end) : "";
    const lowerPrefix = prefix.toLowerCase();
    const items: CompletionItem[] = [];
    // Explicit replacement range: the client's word pattern stops at `.`
    // but our labels can carry qualifiers (`Tool.pencil`, `.loop`), so
    // without this the label gets inserted next to the typed tail.
    const wordEditRange = wordRange ? toRange(document, wordRange.start, wordRange.end) : undefined;
    for (const inst of getInstructionCompletions(lowerPrefix)) {
        const usage = `${inst.mnemonic}${inst.operands ? ` ${inst.operands}` : ""}`;
        const docParts = ["```nasm", usage, "```", ""];
        if (inst.full) {
            docParts.push(`**${inst.full}**`, "");
        }
        docParts.push(inst.summary);
        items.push({
            label: inst.mnemonic,
            kind: CompletionItemKind.Keyword,
            detail: inst.full ? `${inst.full} \u2014 ${usage}` : usage,
            documentation: { kind: MarkupKind.Markdown, value: docParts.join("\n") },
        });
    }
    for (const reg of getRegisterCompletions(lowerPrefix)) {
        const regDetail = `${reg.size}-bit ${reg.category} register`;
        items.push({
            label: reg.name,
            kind: CompletionItemKind.Variable,
            detail: reg.full ? `${reg.full} \u2014 ${regDetail}` : regDetail,
            documentation: reg.full
                ? { kind: MarkupKind.Markdown, value: `**${reg.full}**\n\n${regDetail}.` }
                : undefined,
        });
    }
    for (const dir of getDirectiveCompletions(lowerPrefix)) {
        items.push({
            label: dir.name,
            kind: CompletionItemKind.Keyword,
            documentation: dir.summary,
        });
    }
    const model = documentModels.get(document.uri);
    if (model) {
        for (const sym of model.symbols) {
            if (!lowerPrefix || sym.name.toLowerCase().startsWith(lowerPrefix)) {
                items.push({
                    label: sym.name,
                    kind:
                        sym.kind === "label"
                            ? CompletionItemKind.Function
                            : sym.kind === "data"
                              ? CompletionItemKind.Variable
                              : CompletionItemKind.Constant,
                    detail:
                        sym.kind === "label" ? "label" : sym.kind === "data" ? (sym.detail ?? "data") : "equ constant",
                    documentation: { kind: MarkupKind.Markdown, value: renderSymbolDoc(sym) },
                    ...(wordEditRange
                        ? { textEdit: { range: wordEditRange, newText: sym.name } }
                        : {}),
                });
            }
        }
    }
    const seenNames = new Set(items.map((i) => i.label.toLowerCase()));
    for (const [key, entries] of workspaceIndex) {        if ((lowerPrefix && !key.startsWith(lowerPrefix)) || !entries.length || seenNames.has(key)) {
            continue;
        }
        seenNames.add(key);
        const first = pickIndexEntry(entries);
        const origin = path.basename(fileUriToPath(first.uri));
        items.push({
            label: first.name,
            kind:
                first.kind === "label"
                    ? CompletionItemKind.Function
                    : first.kind === "data"
                      ? CompletionItemKind.Variable
                      : CompletionItemKind.Constant,
            detail: `global \u2014 ${origin}`,
            documentation: {
                kind: MarkupKind.Markdown,
                value: `${renderSymbolDoc(first)}\n\nDefined in \`${origin}\``,
            },
            ...(wordEditRange ? { textEdit: { range: wordEditRange, newText: first.name } } : {}),
        });
    }
    for (const fn of getLibcCompletions(lowerPrefix)) {
        if (seenNames.has(fn.name.toLowerCase())) {
            continue;
        }
        seenNames.add(fn.name.toLowerCase());
        items.push({
            label: fn.name,
            kind: CompletionItemKind.Function,
            detail: `libc \u2014 ${fn.header}`,
            documentation: {
                kind: MarkupKind.Markdown,
                value: renderLibcFunction(fn),
            },
        });
    }
    for (const [key, fns] of headerFunctions) {
        if ((lowerPrefix && !key.startsWith(lowerPrefix)) || !fns.length || seenNames.has(key)) {
            continue;
        }
        seenNames.add(key);
        const first = fns[0];
        items.push({
            label: first.name,
            kind: CompletionItemKind.Function,
            detail: `${first.lib} \u2014 ${first.header}`,
            documentation: {
                kind: MarkupKind.Markdown,
                value: headerDocValue(first),
            },
        });
    }
    // Struct member access (`Name.` or `Name.mem`): the word range includes
    // dots, so split at the last one and complete members only.
    const dotAt = lowerPrefix.lastIndexOf(".");
    if (dotAt > 0) {
        const strucPart = lowerPrefix.slice(0, dotAt);
        const typedStruc = prefix.slice(0, dotAt);
        const memberPrefix = lowerPrefix.slice(dotAt + 1);
        const hits = findStruc(strucPart, model, document.uri);
        if (hits.length > 0) {
            const seenM = new Set<string>();
            for (const { def } of hits) {
                for (const m of def.members) {
                    const bLower = m.bare.toLowerCase();
                    const dedupe = def.name.toLowerCase() + "." + bLower;
                    if (!bLower.startsWith(memberPrefix) || seenM.has(dedupe)) {
                        continue;
                    }
                    seenM.add(dedupe);
                    const qualified = `${def.name}${m.name.startsWith(".") ? m.name : "." + m.name}`;
                    items.push({
                        label: qualified,
                        filterText: `${typedStruc}.${m.bare}`,
                        textEdit: wordEditRange ? { range: wordEditRange, newText: qualified } : undefined,
                        kind:
                            m.kind === "field"
                                ? CompletionItemKind.Field
                                : CompletionItemKind.Constant,
                        detail:
                            m.kind === "field"
                                ? m.size !== null
                                    ? `${sizeName(m.size)} field @ +${m.offset}`
                                    : `field @ +${m.offset}`
                                : m.value
                                  ? `= ${m.value}`
                                  : "struc constant",
                        documentation: {
                            kind: MarkupKind.Markdown,
                            value: renderStrucMember(def.name, m),
                        },
                    });
                }
            }
            return items;
        }
    } else if (!lowerPrefix.includes(".")) {
        // Bare struct names complete as types.
        const offerStruc = (def: StrucDef, origin?: string): void => {
            if (
                (lowerPrefix && !def.name.toLowerCase().startsWith(lowerPrefix)) ||
                seenNames.has(def.name.toLowerCase())
            ) {
                return;
            }
            seenNames.add(def.name.toLowerCase());
            items.push({
                label: def.name,
                kind: CompletionItemKind.Class,
                detail: `struc \u2014 ${def.members.length} members, ${def.totalSize} bytes${origin ? ` \u2014 ${origin}` : ""}`,
                documentation: {
                    kind: MarkupKind.Markdown,
                    value: renderStruc(def, origin),
                },
            });
        };
        if (model) {
            for (const def of model.strucs || []) {
                offerStruc(def);
            }
        }
        for (const arr of workspaceStrucs.values()) {
            if (arr.length > 0) {
                offerStruc(arr[0].def, path.basename(fileUriToPath(arr[0].uri)));
            }
        }
        // Auto-generated `Name_size` constants from workspace strucs.
        {
            const seenSize = new Set<string>();
            const offerSize = (def: StrucDef, origin?: string): void => {
                const label = `${def.name}_size`;
                if (
                    (lowerPrefix && !label.toLowerCase().startsWith(lowerPrefix)) ||
                    seenNames.has(label.toLowerCase()) ||
                    seenSize.has(label.toLowerCase())
                ) {
                    return;
                }
                seenNames.add(label.toLowerCase());
                seenSize.add(label.toLowerCase());
                items.push({
                    label,
                    kind: CompletionItemKind.Constant,
                    detail: `struc size \u2014 ${def.totalSize} bytes${origin ? ` \u2014 ${origin}` : ""}`,
                    documentation: {
                        kind: MarkupKind.Markdown,
                        value: renderStrucSize(def, origin),
                    },
                });
            };
            const sizeHit = findStrucSize(lowerPrefix, model, document.uri);
            if (sizeHit) {
                offerSize(sizeHit.def);
            } else {
                if (model) {
                    for (const def of model.strucs || []) {
                        offerSize(def);
                    }
                }
                for (const arr of workspaceStrucs.values()) {
                    if (arr.length > 0) {
                        offerSize(arr[0].def, path.basename(fileUriToPath(arr[0].uri)));
                    }
                }
            }
        }
    }
    return items;
});

connection.onHover((params): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }
    const position = params.position;
    const offset = document.offsetAt(position);
    const text = document.getText();
    const wordRange = getWordRangeAt(text, offset);
    if (!wordRange) {
        return null;
    }
    const word = text.slice(wordRange.start, wordRange.end);
    const lower = word.toLowerCase();
    const inst = getInstruction(lower);
    if (inst) {
        const value = [
            "```nasm",
            `${inst.mnemonic} ${inst.operands}`.trim(),
            "```",
            "",
            ...(inst.full ? [`**${inst.full}**`, ""] : []),
            inst.summary,
        ];
        return {
            contents: { kind: MarkupKind.Markdown, value: value.join("\n") },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    const reg = getRegister(lower);
    if (reg) {
        const value = [
            "```nasm",
            reg.name,
            "```",
            "",
            ...(reg.full ? [`**${reg.full}**`, ""] : []),
            `${reg.size}-bit ${reg.category} register.`,
        ];
        return {
            contents: { kind: MarkupKind.Markdown, value: value.join("\n") },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    const dir = getDirective(lower);
    if (dir) {
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: ["```nasm", dir.name, "```", "", dir.summary].join("\n"),
            },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    const model = documentModels.get(document.uri);
    if (model) {
        const sym = model.symbols.find((s) => s.name.toLowerCase() === lower);
        if (sym) {
            return {
                contents: { kind: MarkupKind.Markdown, value: renderSymbolDoc(sym) },
                range: toRange(document, wordRange.start, wordRange.end),
            };
        }
    }
    const wsEntries = workspaceIndex.get(lower);
    if (wsEntries && wsEntries.length > 0) {
        const first = pickIndexEntry(wsEntries);
        const parts = [
            renderSymbolDoc(first),
            "",
            `Defined in \`${path.basename(fileUriToPath(first.uri))}\``,
        ];
        if (wsEntries.length > 1) {
            const others = [
                ...new Set(
                    wsEntries.filter((e) => e !== first).map((e) => path.basename(fileUriToPath(e.uri)))
                ),
            ].join(", ");
            parts.push(`Also defined in ${others} (multiple definition).`);
        }
        return {
            contents: { kind: MarkupKind.Markdown, value: parts.join("\n") },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    const libc = getLibcFunction(lower);
    if (libc) {
        return {
            contents: { kind: MarkupKind.Markdown, value: renderLibcFunction(libc) },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    if (lower.includes(".")) {
        const di = lower.lastIndexOf(".");
        const hits = findStruc(lower.slice(0, di), model, document.uri);
        if (hits.length > 0) {
            const first = hits[0];
            const mem = first.def.members.find((m) => m.bare.toLowerCase() === lower.slice(di + 1));
            if (mem) {
                const origin =
                    fileUriToPath(first.uri) === fileUriToPath(document.uri)
                        ? undefined
                        : path.basename(fileUriToPath(first.uri));
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: renderStrucMember(first.def.name, mem, origin),
                    },
                    range: toRange(document, wordRange.start, wordRange.end),
                };
            }
        }
    } else {
        const hits = findStruc(lower, model, document.uri);
        if (hits.length > 0) {
            const first = hits[0];
            const origin =
                fileUriToPath(first.uri) === fileUriToPath(document.uri)
                    ? undefined
                    : path.basename(fileUriToPath(first.uri));
            return {
                contents: { kind: MarkupKind.Markdown, value: renderStruc(first.def, origin) },
                range: toRange(document, wordRange.start, wordRange.end),
            };
        }
        const sizeHit = findStrucSize(lower, model, document.uri);
        if (sizeHit) {
            const origin =
                fileUriToPath(sizeHit.uri) === fileUriToPath(document.uri)
                    ? undefined
                    : path.basename(fileUriToPath(sizeHit.uri));
            return {
                contents: { kind: MarkupKind.Markdown, value: renderStrucSize(sizeHit.def, origin) },
                range: toRange(document, wordRange.start, wordRange.end),
            };
        }
    }
    const headerEntries = headerFunctions.get(lower);
    if (headerEntries && headerEntries.length > 0) {
        return {
            contents: { kind: MarkupKind.Markdown, value: headerDocValue(headerEntries[0]) },
            range: toRange(document, wordRange.start, wordRange.end),
        };
    }
    return null;
});

connection.onDefinition((params): Definition | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }
    const position = params.position;
    const offset = document.offsetAt(position);
    const text = document.getText();
    const wordRange = getWordRangeAt(text, offset);
    if (!wordRange) {
        return null;
    }
    const word = text.slice(wordRange.start, wordRange.end);
    const lower = word.toLowerCase();
    const model = documentModels.get(document.uri);
    if (!model) {
        return null;
    }
    const symbol = model.symbols.find((s) => s.name.toLowerCase() === lower);
    if (!symbol) {
        const wsEntries = workspaceIndex.get(lower);
        if (wsEntries && wsEntries.length > 0) {
            const first = pickIndexEntry(wsEntries);
            const location: Location = {
                uri: first.uri,
                range: {
                    start: { line: first.line, character: first.character },
                    end: { line: first.line, character: first.character + first.name.length },
                },
            };
            return location;
        }
        if (lower.includes(".")) {
            const di = lower.lastIndexOf(".");
            const hits = findStruc(lower.slice(0, di), model, document.uri);
            if (hits.length > 0) {
                const mem = hits[0].def.members.find((m) => m.bare.toLowerCase() === lower.slice(di + 1));
                if (mem) {
                    const memLocation: Location = {
                        uri: hits[0].uri,
                        range: {
                            start: { line: mem.line, character: mem.character },
                            end: { line: mem.line, character: mem.character + mem.name.length },
                        },
                    };
                    return memLocation;
                }
            }
        } else {
            const sizeHit = findStrucSize(lower, model, document.uri);
            if (sizeHit) {
                return {
                    uri: sizeHit.uri,
                    range: {
                        start: { line: sizeHit.def.endLine, character: 0 },
                        end: { line: sizeHit.def.endLine, character: sizeHit.def.name.length + 5 },
                    },
                };
            }
        }
        return null;
    }
    const targetPos = { line: symbol.line, character: symbol.character };
    const location: Location = {
        uri: document.uri,
        range: {
            start: targetPos,
            end: { line: symbol.line, character: symbol.character + symbol.name.length },
        },
    };
    return location;
});

function getWordRangeAt(text: string, offset: number): { start: number; end: number } | null {
    if (offset < 0 || offset > text.length) {
        return null;
    }
    const isWordChar = (ch: string): boolean => /[A-Za-z0-9_.$%]/.test(ch);
    let start = offset;
    let end = offset;
    while (start > 0 && isWordChar(text.charAt(start - 1))) {
        start--;
    }
    while (end < text.length && isWordChar(text.charAt(end))) {
        end++;
    }
    if (start === end) {
        return null;
    }
    return { start, end };
}

function toRange(
    document: TextDocument,
    startOffset: number,
    endOffset: number
): { start: { line: number; character: number }; end: { line: number; character: number } } {
    return { start: document.positionAt(startOffset), end: document.positionAt(endOffset) };
}

function fileUriToPath(uri: string): string {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function scanRoots(): string[] {
    if (workspaceRoot) {
        return [workspaceRoot];
    }
    const dirs = new Set<string>();
    for (const doc of documents.all()) {
        if (doc.uri.startsWith("file://")) {
            dirs.add(path.dirname(fileUriToPath(doc.uri)));
        }
    }
    return [...dirs];
}

const WS_EXTS = new Set([".asm", ".nasm", ".inc"]);
const WS_SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "obj",
    "build",
    "bin",
    "target",
    "out",
    "dist",
    ".vscode",
]);

function collectWorkspaceFiles(roots: string[]): string[] {
    const out: string[] = [];
    const stack = [...roots];
    const seen = new Set<string>();
    while (stack.length > 0 && out.length < 500) {
        const dir = stack.pop() as string;
        if (seen.has(dir)) {
            continue;
        }
        seen.add(dir);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (!WS_SKIP_DIRS.has(ent.name) && !ent.name.startsWith(".")) {
                    stack.push(full);
                }
            } else if (ent.isFile() && WS_EXTS.has(path.extname(ent.name).toLowerCase())) {
                out.push(full);
            }
        }
    }
    return out;
}

function openDocsByPath(): Map<string, string> {
    const m = new Map<string, string>();
    for (const doc of documents.all()) {
        if (doc.uri.startsWith("file://")) {
            m.set(fileUriToPath(doc.uri), doc.getText());
        }
    }
    return m;
}

function indexModel(uri: string, model: DocumentModel): void {
    const globals = new Set(model.globals.map((g) => g.toLowerCase()));
    for (const sym of model.symbols) {
        if (!globals.has(sym.name.toLowerCase())) {
            continue;
        }
        const key = sym.name.toLowerCase();
        const entry: IndexEntry = {
            name: sym.name,
            uri,
            line: sym.line,
            character: sym.character,
            kind: sym.kind,
            doc: sym.doc,
            detail: sym.detail,
        };
        const arr = workspaceIndex.get(key);
        if (arr) {
            arr.push(entry);
        } else {
            workspaceIndex.set(key, [entry]);
        }
    }
}

function refreshWorkspaceIndex(): void {
    workspaceIndex.clear();
    workspaceStrucs.clear();
    const live = openDocsByPath();
    for (const file of collectWorkspaceFiles(scanRoots())) {
        let text = live.get(file);
        if (text === undefined) {
            try {
                if (fs.statSync(file).size > 1024 * 1024) {
                    continue;
                }
                text = fs.readFileSync(file, "utf8");
            } catch {
                continue;
            }
        }
        try {
            const uri = "file://" + encodeURI(file);
            const model = parseDocument(text);
            indexModel(uri, model);
            indexStrucs(uri, model);
        } catch {
            // ignore unparseable files
        }
    }
}

function refreshFileInIndex(uri: string, liveText?: string): void {
    if (!uri.startsWith("file://")) {
        return;
    }
    const file = fileUriToPath(uri);
    for (const [key, arr] of workspaceIndex) {
        const kept = arr.filter((e) => e.uri !== uri && fileUriToPath(e.uri) !== file);
        if (kept.length) {
            workspaceIndex.set(key, kept);
        } else {
            workspaceIndex.delete(key);
        }
    }
    dropUriStrucs(uri, file);
    let text = liveText;
    if (text === undefined) {
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return;
        }
    }
    try {
        const model = parseDocument(text);
        indexModel(uri, model);
        indexStrucs(uri, model);
    } catch {
        // ignore
    }
}

interface StrucEntry {
    def: StrucDef;
    uri: string;
}

const workspaceStrucs = new Map<string, StrucEntry[]>();

function indexStrucs(uri: string, model: DocumentModel): void {
    for (const def of model.strucs || []) {
        const key = def.name.toLowerCase();
        const arr = workspaceStrucs.get(key) || [];
        arr.push({ def, uri });
        workspaceStrucs.set(key, arr);
    }
}

function dropUriStrucs(uri: string, file: string): void {
    for (const [key, arr] of workspaceStrucs) {
        const kept = arr.filter((e) => e.uri !== uri && fileUriToPath(e.uri) !== file);
        if (kept.length) {
            workspaceStrucs.set(key, kept);
        } else {
            workspaceStrucs.delete(key);
        }
    }
}

/** Local strucs first, then workspace ones (excluding this document's own, already covered). */
function findStruc(name: string, model: DocumentModel | undefined, docUri: string): StrucEntry[] {
    const key = name.toLowerCase();
    const out: StrucEntry[] = [];
    if (model) {
        for (const def of model.strucs || []) {
            if (def.name.toLowerCase() === key) {
                out.push({ def, uri: docUri });
            }
        }
    }
    for (const e of workspaceStrucs.get(key) || []) {
        if (fileUriToPath(e.uri) !== fileUriToPath(docUri)) {
            out.push(e);
        }
    }
    return out;
}

/** Resolve `Name_size` against local + workspace struc definitions. */
function findStrucSize(
    lower: string,
    model: DocumentModel | undefined,
    docUri: string
): { def: StrucDef; uri: string } | null {
    const m = /^(.*)_size$/.exec(lower);
    if (!m) {
        return null;
    }
    const hits = findStruc(m[1], model, docUri);
    return hits.length > 0 ? hits[0] : null;
}

function renderStrucSize(def: StrucDef, origin?: string): string {
    const lines = ["```nasm", `${def.name}_size`, "```", "", strucSizeBrief(def)];
    if (origin) {
        lines.push("", `Defined in \`${origin}\`.`);
    }
    return lines.join("\n");
}

function sizeName(size: number | null): string {
    switch (size) {
        case 1:
            return "byte";
        case 2:
            return "word";
        case 4:
            return "dword";
        case 8:
            return "qword";
        case 10:
            return "tword";
        case 16:
            return "oword";
        case 32:
            return "yword";
        case 64:
            return "zword";
        default:
            return size === null ? "" : `${size} bytes`;
    }
}

function renderStrucMember(strucName: string, m: StrucMember, origin?: string): string {
    const lines = ["```nasm", `${strucName}.${m.bare}`, "```", ""];
    if (m.kind === "field") {
        const dims = [`offset ${m.offset}`, m.size !== null ? `${m.size} byte${m.size === 1 ? "" : "s"} (${sizeName(m.size)})` : "unknown size"];
        if ((m.count ?? 1) > 1) {
            dims.push(`× ${m.count}`);
        }
        lines.push(`Field of struc \`${strucName}\` — ${dims.join(", ")}.`);
    } else {
        lines.push(`Constant \`${strucName}.${m.bare}\`${m.value ? ` = ${m.value}` : ""}.`);
    }
    if (m.brief) {
        lines.push("", m.brief);
    }
    if (origin) {
        lines.push("", `Defined in \`${origin}\`.`);
    }
    return lines.join("\n");
}

function renderStruc(def: StrucDef, origin?: string): string {
    const lines = ["```nasm", `struc ${def.name}`, "```", ""];
    lines.push(`${def.members.length} member${def.members.length === 1 ? "" : "s"}, ${def.totalSize} bytes.`);
    lines.push("");
    for (const m of def.members) {
        if (m.kind === "field") {
            lines.push(`- \`${m.bare}\` — +${m.offset}, ${sizeName(m.size)}`);
        } else {
            lines.push(`- \`${m.bare}\`${m.value ? ` = ${m.value}` : ""}`);
        }
    }
    if (origin) {
        lines.push("", `Defined in \`${origin}\`.`);
    }
    return lines.join("\n");
}

function pickIndexEntry(entries: IndexEntry[]): IndexEntry {    for (const e of entries) {
        const doc = e.doc;
        if (doc && (doc.brief.some((l) => l.trim()) || doc.params.length > 0 || doc.returns.length > 0)) {
            return e;
        }
    }
    return entries[0];
}

function getWorkspaceDiagnostics(doc: TextDocument): Diagnostic[] {
    const out: Diagnostic[] = [];
    if (!doc.uri.startsWith("file://")) {
        return out;
    }
    const model = documentModels.get(doc.uri);
    if (!model) {
        return out;
    }
    const settings = activeSettings;
    const docLines = doc.getText().split(/\r?\n/);
    const at = (line: number): { start: { line: number; character: number }; end: { line: number; character: number } } => ({
        start: { line, character: 0 },
        end: { line, character: (docLines[line] || "").length },
    });
    if (model.globals) {
        const globals = new Set(model.globals.map((g) => g.toLowerCase()));
        const seen = new Set<string>();
        for (const sym of model.symbols) {
            const key = sym.name.toLowerCase();
            if (!globals.has(key) || seen.has(key)) {
                continue;
            }
            seen.add(key);
            const others = (workspaceIndex.get(key) || []).filter(
                (e) => fileUriToPath(e.uri) !== fileUriToPath(doc.uri)
            );
            if (!others.length) {
                continue;
            }
            const files = [...new Set(others.map((e) => path.basename(fileUriToPath(e.uri))))].join(", ");
            out.push({
                range: at(sym.line),
                message: `multiple definition of \`${sym.name}\`; also defined in ${files}`,
                severity: DiagnosticSeverity.Error,
                source: "nasm",
            });
        }
    }
    if (settings.diagnostics.unresolvedExterns && model.externs) {
        libraryIndex.ensure(settings.libraries);
        ensureHeaderIndex(settings.libraries);
        const libList = settings.libraries.length ? settings.libraries.join(", ") : "(none configured)";
        for (const ext of model.externs) {
            const key = ext.name.toLowerCase();
            if (workspaceIndex.has(key) || libraryIndex.provides(ext.name) || headerFunctions.has(key)) {
                continue;
            }
            out.push({
                range: at(ext.line),
                message: `unresolved extern \`${ext.name}\`: not defined in the workspace or in libraries (${libList})`,
                severity: DiagnosticSeverity.Warning,
                source: "nasm",
            });
        }
    }
    if (settings.diagnostics.stackCheck) {
        for (const issue of analyzeStack(doc.getText(), model)) {
            out.push({
                range: at(issue.line),
                message: issue.message,
                severity: DiagnosticSeverity.Error,
                source: "nasm",
            });
        }
    }
    return out;
}

function publishMergedDiagnostics(doc: TextDocument): void {
    const cached = nasmDiagnosticsCache.get(doc.uri) || [];
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [...cached, ...getWorkspaceDiagnostics(doc)] });
}

connection.onRequest(
    "textDocument/semanticTokens/full",
    (params: { textDocument: { uri: string } }): { data: number[] } => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return { data: [] };
        }
        const model = documentModels.get(document.uri) ?? parseDocument(document.getText());
        const tokens = pairPushPop(document.getText(), model)
            .map((t) => ({ ...t, color: t.pair % 6 }))
            .sort((a, b) => (a.line === b.line ? a.character - b.character : a.line - b.line));
        const data: number[] = [];
        let prevLine = 0;
        let prevChar = 0;
        for (const t of tokens) {
            data.push(
                t.line - prevLine,
                t.line === prevLine ? t.character - prevChar : t.character,
                t.length,
                0,
                1 << t.color
            );
            prevLine = t.line;
            prevChar = t.character;
        }
        return { data };
    }
);

documents.listen(connection);
connection.listen();
