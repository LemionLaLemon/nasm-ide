// nasm-ide test suite: unit + LSP integration. Run with `npm test`.
const { spawn, spawnSync, execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SERVER_OUT = path.join(ROOT, "server", "out");

let fails = 0;
const ok = (c, m) => {
    console.log((c ? "ok: " : "FAIL: ") + m);
    if (!c) {
        fails++;
    }
};

function unit() {
    const D = require(path.join(SERVER_OUT, "nasmData.js"));
    ok(D.getInstructionCompletions("").length === 198, "198 instructions");
    ok(D.getRegisterCompletions("").length === 136, "136 registers");
    ok(D.getDirectiveCompletions("").length === 14, "14 directives");
    ok(D.getInstruction("addsd").full === "Add Scalar Double-Precision", "addsd full");
    ok(D.getInstruction("cqo").full === "Convert Quadword to Octaword", "cqo full");
    ok(D.getRegister("r12b").full.includes("General Purpose"), "r12b full");

    const P = require(path.join(SERVER_OUT, "parser.js"));
    let m = P.parseDocument("global calcStrExpr\nextern strtod ; C lib\ncalcStrExpr:\n ret\n");
    ok(m.globals.join() === "calcStrExpr" && m.externs.map((e) => e.name).join() === "strtod", "globals/externs");
    ok(typeof m.externs[0].line === "number", "extern has line");
    m = P.parseDocument("global foo, bar\nextern printf, scanf\nGLOBAL U\nfoo:\n ret\n");
    ok(m.globals.join() === "foo,bar,U" && m.externs.length === 2, "lists + uppercase");
    m = P.parseDocument("global r:function\nr:\n ret\n");
    ok(m.globals.join() === "r", "ELF suffix stripped");
    const doc = (lines) => P.parseDocument(lines.join("\n") + "\nfn:\n ret\n").symbols[0].doc;
    let d = doc(["; Brief.", ";---@param eax first operand", ";---@return eax the sum"]);
    ok(d.brief.join(" ").includes("Brief") && d.params[0].name === "eax" && d.returns[0].name === "eax", "doc block");
    d = doc(["; @return byte rax current character"]);
    ok(d.returns[0].size === "byte" && d.returns[0].name === "rax", "leading size");
    d = doc(["; @param buf 192 bytes str buffer"]);
    ok(d.params[0].size === "192 bytes" && d.params[0].desc === "str buffer", "N bytes size");
    d = doc(["; @param rax 64 bit signed integer"]);
    ok(!d.params[0].size && d.params[0].desc === "64 bit signed integer", "64 bit stays desc");
    d = doc([";; @param eax x"]);
    ok(d.params[0].name === "eax", ";; marker");
    const r = P.renderSymbolDoc(
        P.parseDocument("; T\n; @param rax - 64 bit\n; @return rax result\nfn:\n ret\n").symbols[0]
    );
    ok(r.includes("- `rax` - 64 bit") && r.includes("- `rax` - result") && !r.includes("\u2014"), "hyphen format");
    const sep = P.parseDocument(";---\n; head\n;---\nfn:\n ret\n").symbols[0];
    ok(sep.doc.brief.length === 0, "separators ignored");
    const g = P.parseDocument("; B\n; @param rdi b\nglobal foo\nfoo:\n ret\n").symbols[0];
    ok(g.doc.brief.join(" ").includes("B"), "docs see through global");

    const SSRC = [
        "; Buttons.",
        "struc Button",
        "    .x resd 1 ; x position",
        "    .y resd 1",
        "    .label resq 1",
        "    .kind equ 0",
        "endstruc",
        "",
        "struc Tool",
        "    .pencil equ 6",
        "endstruc",
        "",
        "struc XConfigureEvent",
        "    .type resd 1",
        "    resb 44",
        "    .x resd 1",
        "endstruc",
    ].join("\n");
    const sm = P.parseDocument(SSRC);
    ok(sm.strucs.length === 3, "three strucs parsed");
    const btn = sm.strucs[0];
    ok(btn.totalSize === 16, "Button is 16 bytes");
    ok(
        btn.members.map((m) => `${m.name}@${m.offset}`).join(" ") === ".x@0 .y@4 .label@8 .kind@null",
        "member offsets: " + btn.members.map((m) => `${m.name}@${m.offset}`).join(" ")
    );
    ok(btn.members[0].brief === "x position" && btn.members[0].size === 4, "trailing comment + size");
    ok(btn.members[3].kind === "const" && btn.members[3].value === "0", "equ member");
    ok(sm.strucs[2].members[1].offset === 48, "padding advances offset (XConfigureEvent.x @ 48)");
    ok(sm.symbols.some((s) => s.name === "Button_size" && /16 bytes/.test(s.doc.brief[0])), "Name_size synthesized");
    ok(
        P.parseDocument("struc A\n .a resd 1\nstruc B\n .b resd 1\nendstruc\n").strucs.map((s) => s.name).join() === "A,B",
        "nested struc closes outer"
    );
    ok(P.parseDocument("struc C\n .c resd 1\n").strucs.length === 1, "unclosed struc tolerated");

    const DSRC = [
        "section .bss",
        "    screen_num resb 4",
        "    ev resb 192",
        "section .data",
        '    windowtitle db "Paint",0',
        "    count: resd 1",
        "    mask equ 1",
        "mainloop:",
        "    mov eax, 1",
        "    global foo",
    ].join("\n");
    const dm = P.parseDocument(DSRC);
    const byName = (n) => dm.symbols.find((s) => s.name === n);
    ok(byName("screen_num").kind === "data" && byName("screen_num").detail === "4 bytes", "resb with size");
    ok(byName("ev").detail === "192 bytes", "large reserve");
    ok(byName("windowtitle").kind === "data" && /db/.test(byName("windowtitle").detail), "db initialized");
    ok(byName("count").kind === "data", "colon form is data, not label");
    ok(byName("mask").kind === "const" && byName("mainloop").kind === "label", "equ/labels unchanged");
    ok(!byName("mov") && !byName("global") && !byName("section"), "instructions/directives not symbols");
    ok(P.renderSymbolDoc(byName("screen_num")).includes("4 bytes"), "data hover renders size");

    // Emoji labels are legal NASM and common enough in this codebase.
    const emoji = P.parseDocument("main:\n .go👍:\n jmp .go👍\nother:\n .go👍:\n ret\n");
    ok(emoji.symbols.some((s) => s.name === ".go👍"), "emoji local label parsed");
    ok(P.findSymbolInScope(emoji, ".go👍", 2).line === 1, "emoji label resolves in first scope");
    ok(P.findSymbolInScope(emoji, ".go👍", 4).line === 4, "emoji label resolves in second scope");

    // Duplicate local labels: resolve and complete within the enclosing scope.
    const scoped = P.parseDocument(
        "one:\n jmp .done\n.done:\n ret\ntwo:\n jmp .done\n.done:\n ret\n"
    );
    ok(P.findSymbolInScope(scoped, ".done", 1).line === 2, "local label resolves to own scope");
    ok(P.findSymbolInScope(scoped, ".done", 5).line === 6, "duplicate local label resolves per function");
    const oneScope = P.symbolsForCompletion(scoped, 1);
    ok(oneScope.filter((s) => s.name === ".done").length === 1, "completion offers one .done");
    ok(!oneScope.some((s) => s.line === 6), "completion omits locals from other scopes");

    const L = require(path.join(SERVER_OUT, "libscan.js"));
    const cache = L.ldconfigMap();
    ok(cache.size > 100, `ldconfig entries (${cache.size})`);
    const libc = L.resolveLibrary("c");
    ok(!!libc && fs.existsSync(libc), "resolve -lc: " + libc);
    if (process.arch === "x64") {
        ok(!/\/lib32\//.test(libc), "native 64-bit libc preferred over multilib: " + libc);
        ok(!/\/lib32\//.test(cache.get("libc.so.6") || ""), "ldconfig keeps native duplicate: " + cache.get("libc.so.6"));
    }
    ok(L.resolveLibrary("definitely_not_a_lib_xyz") === null, "unknown lib -> null");
    const syms = L.nmDefinedSymbols(libc);
    ok(syms.has("printf") && syms.has("malloc") && syms.has("strtod"), "libc exports parsed");
    // Debian/Arch ncurses dev files are GNU ld scripts (INPUT(-lncursesw));
    // nm can't read those directly, so follow the script.
    const ncurses = L.resolveLibrary("ncurses");
    if (ncurses) {
        const ns = L.nmDefinedSymbols(ncurses);
        ok(
            ns.has("initscr") && ns.has("stdscr") && ns.has("endwin") && ns.has("curs_set"),
            "ncurses exports resolved through ld script: " + ncurses
        );
    }
    const cands = L.listLibraryCandidates();
    ok(cands.length > 50 && cands.some((c) => c.flag === "c"), `candidates (${cands.length})`);

    const LC = require(path.join(SERVER_OUT, "libcData.js"));
    const all = LC.getLibcCompletions("");
    ok(all.length >= 50, `libc dataset (${all.length})`);
    ok(LC.getLibcFunction("printf").signature.includes("const char *format"), "printf signature");
    const rp = LC.renderLibcFunction(LC.getLibcFunction("printf"));
    ok(rp.includes("`rdi` - format") && rp.includes("`rax` - number of vector") && rp.includes("clobber"), "printf ABI render");
    const rs = LC.renderLibcFunction(LC.getLibcFunction("sqrt"));
    ok(rs.includes("`xmm0` - x:") && rs.includes("-lm"), "sqrt uses xmm0 + lm hint");
    const rf = LC.renderLibcFunction(LC.getLibcFunction("free"));
    ok(!rf.includes("**Returns**") && rf.includes("`rdi` - ptr"), "void fn has no Returns");

    const { LibraryIndex } = require(path.join(SERVER_OUT, "libraries.js"));
    const idx = new LibraryIndex();
    ok(idx.ensure(["c"]) === true, "index builds");
    ok(idx.ensure(["c"]) === false, "index cached");
    ok(idx.provides("printf") && !idx.provides("totally_made_up_xyz"), "provides()");
    ok(idx.providesIn("c", "printf") && !idx.providesIn("c", "nope"), "per-lib providesIn");
    if (L.resolveLibrary("ncurses")) {
        const ncIdx = new LibraryIndex();
        ncIdx.ensure(["c", "ncurses"]);
        ok(
            ncIdx.provides("initscr") && ncIdx.provides("stdscr") && ncIdx.provides("printf"),
            "c + ncurses index covers both libraries"
        );
    }

    const S = require(path.join(SERVER_OUT, "stackcheck.js"));
    const P2 = require(path.join(SERVER_OUT, "parser.js"));
    const stackOf = (src) => S.analyzeStack(src, P2.parseDocument(src));
    ok(stackOf("foo:\n    push rbx\n    pop rbx\n    ret\n").length === 0, "balanced function silent");
    // branch that skips the normal epilogue pops: its own pops are valid
    const branchSrc = [
        "draw:",
        "    push rbp",
        "    push rbx",
        "    test eax, eax",
        "    jc .failed",
        "    pop rbx",
        "    pop rbp",
        "    ret",
        ".failed:",
        "    pop rbx",
        "    pop rbp",
        "    ret",
    ].join("\n");
    ok(stackOf(branchSrc).length === 0, "pops on a branch path that skipped earlier pops are valid");
    const branchPairs = new Map(S.pairPushPop(branchSrc, P2.parseDocument(branchSrc)).map((t) => [t.line, t.pair]));
    ok(
        branchPairs.get(5) === 1 && branchPairs.get(6) === 0 && branchPairs.get(9) === 1 && branchPairs.get(10) === 0,
        "branch paths pair pops with the same pushes: " + JSON.stringify([...branchPairs])
    );
    ok(stackOf("f:\n    jc .b\n    jmp .b\n.b:\n    pop rax\n    ret\n").length > 0, "genuinely empty stack still flagged");
    ok(stackOf("f:\n    push rbx\n.loop:\n    dec eax\n    jnz .loop\n    pop rbx\n    ret\n").length === 0, "loop body silent");
    ok(stackOf("f:\n    push rbx\n    jmp .out\n.out:\n    pop rbx\n    ret\n").length === 0, "tail path keeps stack depth");
    ok(stackOf("f:\n    jmp .done\n    push rbx\n.done:\n    ret\n").length === 0, "dead code after jmp not flagged");
    let iss = stackOf("foo:\n    push rbx\n    push r12\n    ret\n");
    ok(iss.length === 3 && iss.some((d) => /never popped/.test(d.message)), "forgotten pops flagged");
    iss = stackOf("foo:\n    pop rbx\n    ret\n");
    ok(iss.some((d) => /without a matching push/.test(d.message)), "pop on empty stack flagged");
    iss = stackOf("foo:\n    push rbx\n    pop rbx\n    pop rbx\n    ret\n");
    ok(iss.some((d) => d.line === 3), "second pop flagged");
    iss = stackOf("global foo\nextern bar\nfoo:\n    push rbx\n    pop rbx\n    ret\n");
    ok(iss.length === 0, "decls ignored, balanced silent");
    ok(idx.providesIn("c", "printf") && !idx.providesIn("c", "nope"), "per-lib providesIn");

    const H = require(path.join(SERVER_OUT, "headerdocs.js"));
    const protos = H.extractPrototypes("t.h", [
        "extern int alpha(int a, int b);",
        "typedef int (*cmp_t)(const void *, const void *);",
        "#define MAX THING(1)",
        "extern void beta(",
        "    Display *d,",
        "    int x);",
        "int __hidden(void);",
        "ALLCAPS(x);",
    ].join("\n"));
    ok(protos.length === 2 && protos[0].name === "alpha", "prototypes parsed, junk skipped");
    ok(protos[1].name === "beta" && protos[1].signature.includes("Display *d"), "multiline prototype joined");
    const manText = "NAME\n     XFoo, XBar - frobnicate widgets\n\nSYNOPSIS";
    ok(H.parseManName(manText) === "frobnicate widgets", "man NAME parsed");
    const hasX11pc = H.pcByLib().get("X11");
    ok(!hasX11pc || hasX11pc.endsWith("x11.pc"), "X11 resolves to x11.pc" + (hasX11pc ? "" : " (skipped, no x11.pc)"));
    if (hasX11pc) {
        const xi = H.buildHeaderIndex(["X11"]);
        ok((xi.functions.get("xcreatewindow") || []).length > 0, "unfiltered scan finds XCreateWindow");
    }
    if (H.manSummary) {
        const liveMan = (() => {
            try {
                return H.manSummary("printf");
            } catch {
                return "";
            }
        })();
        ok(!liveMan || /format|print/i.test(liveMan), "live man lookup sane: " + JSON.stringify(liveMan).slice(0, 60));
    }
}

// --- LSP harness ---
function lspClient(serverJs, extraEnv) {
    const proc = spawn("node", [serverJs, "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
    proc.stderr.on("data", (d) => console.log("SERVER STDERR:", d.toString().slice(0, 500)));
    let buf = Buffer.alloc(0);
    const pending = new Map();
    const notes = [];
    proc.stdout.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (true) {
            const h = buf.indexOf("\r\n\r\n");
            if (h < 0) {
                break;
            }
            const len = parseInt(buf.slice(0, h).toString().split("Content-Length:")[1], 10);
            if (buf.length < h + 4 + len) {
                break;
            }
            const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString());
            buf = buf.slice(h + 4 + len);
            if (msg.id !== undefined && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            } else if (msg.id !== undefined && msg.method) {
                // server -> client request (workspace/configuration, registerCapability)
                let result = null;
                if (msg.method === "workspace/configuration") {
                    result = ((msg.params && msg.params.items) || []).map(() => api.cannedSettings);
                }
                const s = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
                proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
            } else if (msg.method) {
                notes.push(msg);
            }
        }
    });
    const send = (m) => {
        const s = JSON.stringify(m);
        proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
    };
    // Client request ids start high so they can never collide with the ids the
    // server uses for its own workspace/configuration requests.
    let id = 1000;
    const api = {
        proc,
        notes,
        cannedSettings: null,
        req: (method, params) =>
            new Promise((res) => {
                const i = ++id;
                pending.set(i, res);
                send({ jsonrpc: "2.0", id: i, method, params });
            }),
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    };
    return api;
}

async function integration() {
    const WS = "/tmp/opencode/asm-setup/nasmide-test";
    execSync(`rm -rf ${WS} && mkdir -p ${WS}`);
    const A = ["; Calculates.", "; @param rdi buf", "global calcStrExpr", "calcStrExpr:", "    ret", ""].join("\n");
    const B = ["extern calcStrExpr", "extern printf", "extern bogus_sym_xyz", "_start:", "    call calcStrExpr", "    ret", ""].join("\n");
    fs.writeFileSync(`${WS}/a.asm`, A);
    fs.writeFileSync(`${WS}/b.asm`, B);
    const S = [
        "section .text",
        "main:",
        "    mov r12, r13",
        "    jmp .lo",
        ".loop:",
        "    jbe .height👍",
        ".height👍:",
        "    ret",
        "other:",
        "    jmp .loop",
        ".loop:",
        "    ret",
        "",
    ].join("\n");
    fs.writeFileSync(`${WS}/scope.asm`, S);

    const c = lspClient(path.join(SERVER_OUT, "server.js"));
    const cannedSettings = {
        nasmPath: "nasm",
        arch: "x86_64",
        diagnostics: { enable: true, mode: "asYouType", debounceMs: 100, unresolvedExterns: true, stackCheck: true },
        libraries: ["c", "X11"],
    };
    c.cannedSettings = cannedSettings;
    await c.req("initialize", {
        processId: process.pid,
        rootUri: `file://${WS}`,
        capabilities: { workspace: { configuration: true } },
    });
    c.notify("initialized", {});
    const open = (f) =>
        c.notify("textDocument/didOpen", {
            textDocument: { uri: `file://${WS}/${f}`, languageId: "nasm", version: 1, text: fs.readFileSync(`${WS}/${f}`, "utf8") },
        });
    open("a.asm");
    open("b.asm");
    open("scope.asm");
    await new Promise((r) => setTimeout(r, 600));

    const scUri = `file://${WS}/scope.asm`;
    const compDone = await c.req("textDocument/completion", {
        textDocument: { uri: scUri },
        position: { line: 2, character: "    mov r12, r13".length },
    });
    const doneLabels = (compDone.result || []).map((i) => i.label);
    ok(doneLabels.includes("r13") && doneLabels.includes("r13d"), "completed token still completes (no server-side suppression)");

    const compLo = await c.req("textDocument/completion", {
        textDocument: { uri: scUri },
        position: { line: 3, character: 11 },
    });
    const loLabels = (compLo.result || []).map((i) => i.label);
    ok(loLabels.includes(".loop") && loLabels.filter((l) => l === ".loop").length === 1, "scoped local label completion: " + loLabels);

    const defOther = await c.req("textDocument/definition", {
        textDocument: { uri: scUri },
        position: { line: 9, character: 12 },
    });
    ok(defOther.result && defOther.result.range.start.line === 10, "local label definition follows scope");

    const defEmoji = await c.req("textDocument/definition", {
        textDocument: { uri: scUri },
        position: { line: 5, character: 12 },
    });
    ok(defEmoji.result && defEmoji.result.range.start.line === 6, "emoji label definition");

    const hovScoped = await c.req("textDocument/hover", {
        textDocument: { uri: scUri },
        position: { line: 9, character: 12 },
    });
    const hovScopedText = (hovScoped.result && hovScoped.result.contents && hovScoped.result.contents.value) || "";
    ok(hovScopedText.includes("Local label under `other`"), "local label hover shows scope");

    const hov = await c.req("textDocument/hover", { textDocument: { uri: `file://${WS}/b.asm` }, position: { line: 4, character: 12 } });
    const hv = (hov.result && hov.result.contents && hov.result.contents.value) || "";
    ok(hv.includes("Calculates.") && hv.includes("Defined in `a.asm`"), "cross-file hover");

    const comp = await c.req("textDocument/completion", { textDocument: { uri: `file://${WS}/b.asm` }, position: { line: 4, character: 14 } });
    const item = (comp.result || []).find((i) => i.label === "calcStrExpr");
    ok(!!item && item.detail.includes("a.asm"), "cross-file completion");

    const def = await c.req("textDocument/definition", { textDocument: { uri: `file://${WS}/b.asm` }, position: { line: 4, character: 12 } });
    ok(def.result && def.result.uri === `file://${WS}/a.asm`, "cross-file definition");

    // libc: printf completes with signature + hover shows docs + link hint
    const pUri = `file://${WS}/p.asm`;
    c.notify("textDocument/didOpen", {
        textDocument: { uri: pUri, languageId: "nasm", version: 1, text: "global _start\n_start:\n    call print" },
    });
    await new Promise((r) => setTimeout(r, 300));
    const compP = await c.req("textDocument/completion", { textDocument: { uri: pUri }, position: { line: 2, character: 14 } });
    const printfItem = (compP.result || []).find((i) => i.label === "printf");
    ok(!!printfItem && printfItem.detail.includes("stdio.h"), "libc completion for printf");
    ok(printfItem && printfItem.documentation.value.includes("int printf(const char"), "libc signature in docs");
    const hovP = await c.req("textDocument/hover", { textDocument: { uri: `file://${WS}/b.asm` }, position: { line: 1, character: 9 } });
    const hvP = (hovP.result && hovP.result.contents && hovP.result.contents.value) || "";
    ok(hvP.includes("int printf(const char") && hvP.includes("link with `-lc`"), "libc hover with link hint");
    ok(hvP.includes("System V AMD64") && hvP.includes("`rdi` - format"), "libc hover maps ABI registers");

    // header-autogenerated docs for configured non-libc libraries (gated on X11 presence)
    const LS = require(path.join(SERVER_OUT, "libscan.js"));
    // library changes apply live: shrink to ["c"], notify, assert X11 gone;
    // restore ["c","X11"], notify, assert X11 back — all without keystrokes.
    if (LS.resolveLibrary("X11")) {
        const x2Uri = `file://${WS}/x2.asm`;
        c.notify("textDocument/didOpen", {
            textDocument: { uri: x2Uri, languageId: "nasm", version: 1, text: "_start:\n    call XCre" },
        });
        await new Promise((r) => setTimeout(r, 300));
        c.cannedSettings.libraries = ["c"];
        c.notify("workspace/didChangeConfiguration", { settings: {} });
        await new Promise((r) => setTimeout(r, 800));
        const compOff = await c.req("textDocument/completion", { textDocument: { uri: x2Uri }, position: { line: 1, character: 13 } });
        ok(!(compOff.result || []).some((i) => i.label === "XCreateWindow"), "X11 docs drop when library removed");
        c.cannedSettings.libraries = ["c", "X11"];
        c.notify("workspace/didChangeConfiguration", { settings: {} });
        await new Promise((r) => setTimeout(r, 1200));
        const compOn = await c.req("textDocument/completion", { textDocument: { uri: x2Uri }, position: { line: 1, character: 13 } });
        const xOn = (compOn.result || []).find((i) => i.label === "XCreateWindow");
        ok(!!xOn && xOn.detail.includes("X11"), "X11 docs appear with no reload, no keystroke");
        const xUri = `file://${WS}/x.asm`;
        c.notify("textDocument/didOpen", {
            textDocument: {
                uri: xUri,
                languageId: "nasm",
                version: 1,
                text: "extern XCreateWindow\n_start:\n    call XCreateWindow\n",
            },
        });
        await new Promise((r) => setTimeout(r, 500));
        const hovX = await c.req("textDocument/hover", { textDocument: { uri: xUri }, position: { line: 2, character: 12 } });
        const hvX = (hovX.result && hovX.result.contents && hovX.result.contents.value) || "";
        ok(hvX.includes("Window XCreateWindow(") && hvX.includes("Xlib.h"), "header hover shows prototype + header");
        ok(hvX.includes("System V AMD64") && hvX.includes("link with `-lX11`"), "header hover has ABI + lib hint");
        const compX = await c.req("textDocument/completion", { textDocument: { uri: xUri }, position: { line: 2, character: 13 } });
        const xItem = (compX.result || []).find((i) => i.label === "XCreateWindow");
        ok(!!xItem && xItem.detail.includes("X11"), "header completion offers XCreateWindow");
        c.notes.length = 0;
        c.notify("textDocument/didSave", { textDocument: { uri: xUri } });
        const dx = await new Promise((res, rej) => {
            const t0 = Date.now();
            const poll = () => {
                const i = c.notes.findIndex((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === xUri);
                if (i >= 0) {
                    return res(c.notes.splice(i, 1)[0].params.diagnostics);
                }
                if (Date.now() - t0 > 8000) {
                    return rej(new Error("timeout x11"));
                }
                setTimeout(poll, 50);
            };
            poll();
        });
        ok(!dx.some((d) => /XCreateWindow/.test(d.message)), "nm-provided extern stays quiet");
    } else {
        console.log("(skip: no X11 on this system)");
    }

    // candidates request (library picker backend)
    const cands = await c.req("nasmIde/listLibraryCandidates");
    ok(Array.isArray(cands.result) && cands.result.some((x) => x.flag === "c"), "listLibraryCandidates request");

    // unresolved extern: bogus_sym_xyz warns, printf (libc) stays quiet
    c.notify("textDocument/didSave", { textDocument: { uri: `file://${WS}/b.asm` } });
    const diags = await new Promise((res, rej) => {
        const t0 = Date.now();
        const poll = () => {
            const i = c.notes.findIndex((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === `file://${WS}/b.asm`);
            if (i >= 0) {
                return res(c.notes.splice(i, 1)[0].params.diagnostics);
            }
            if (Date.now() - t0 > 8000) {
                return rej(new Error("timeout"));
            }
            setTimeout(poll, 50);
        };
        poll();
    });
    ok(diags.some((d) => d.severity === 2 && /bogus_sym_xyz/.test(d.message)), "unresolved extern warns: " + JSON.stringify(diags));
    ok(!diags.some((d) => /printf/.test(d.message)), "libc extern quiet");

    // as-you-type: broken file diagnostics arrive WITHOUT save (debounced)
    const brokenUri = `file://${WS}/broken.asm`;
    c.notify("textDocument/didOpen", {
        textDocument: { uri: brokenUri, languageId: "nasm", version: 1, text: "global _start\n_start:\n    pop\n" },
    });
    const auto = await new Promise((res, rej) => {
        const t0 = Date.now();
        const poll = () => {
            const matches = c.notes.filter((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === brokenUri);
            const hit = matches.find((n) => n.params.diagnostics.some((d) => d.severity === 1 && /opcode|operand/.test(d.message)));
            if (hit) {
                return res(hit.params.diagnostics);
            }
            if (Date.now() - t0 > 8000) {
                return rej(new Error("timeout asyoutype"));
            }
            setTimeout(poll, 50);
        };
        poll();
    });
    ok(auto.length > 0, "as-you-type diagnostics without save");

    // strucs: cross-file member completion, hover with offsets, goto-def
    fs.writeFileSync(
        `${WS}/s.asm`,
        ["struc Button", "    .x resd 1", "    .w resd 1", "    .width resd 1", "    .kind equ 0", "endstruc", "global useit", "useit:", "    ret", ""].join("\n")
    );
    const uText = ["extern useit", "_start:", "    mov eax, [rcx + Button.]", "    mov eax, [rcx + Button.w]", "    mov eax, Button_size", "    mov eax, [rcx + Button.wid]", ""].join("\n");
    fs.writeFileSync(`${WS}/u.asm`, uText);
    const sUri = `file://${WS}/s.asm`;
    c.notify("textDocument/didOpen", { textDocument: { uri: sUri, languageId: "nasm", version: 1, text: fs.readFileSync(`${WS}/s.asm`, "utf8") } });
    await new Promise((r) => setTimeout(r, 200));
    const uUri = `file://${WS}/u.asm`;
    c.notify("textDocument/didOpen", { textDocument: { uri: uUri, languageId: "nasm", version: 1, text: uText } });
    await new Promise((r) => setTimeout(r, 400));
    const compDot = await c.req("textDocument/completion", { textDocument: { uri: uUri }, position: { line: 2, character: 27 } });
    const dotLabels = (compDot.result || []).map((i) => i.label).sort();
    ok(dotLabels.join() === "Button.kind,Button.w,Button.width,Button.x", "members complete after Button.: " + dotLabels.join());
    const compW = await c.req("textDocument/completion", { textDocument: { uri: uUri }, position: { line: 5, character: 30 } });
    const wLabels = (compW.result || []).map((i) => i.label).sort();
    ok(wLabels.join() === "Button.width", "members filtered by longer prefix: " + wLabels.join());
    const wItem = (compW.result || []).find((i) => i.label === "Button.width");
    const wEdit = wItem && wItem.textEdit;
    ok(
        !!wEdit && wEdit.newText === "Button.width" && wEdit.range.start.character === 20 && wEdit.range.end.character === 30,
        "member textEdit replaces the whole qualified word (no Tool.Tool duplication)"
    );
    // local dot-labels get the same treatment: `.lo` must become `.loop`, not `..loop`
    const dUri = `file://${WS}/dot.asm`;
    c.notify("textDocument/didOpen", {
        textDocument: { uri: dUri, languageId: "nasm", version: 1, text: ".loop:\n    jmp .lo" },
    });
    await new Promise((r) => setTimeout(r, 300));
    const compD = await c.req("textDocument/completion", { textDocument: { uri: dUri }, position: { line: 1, character: 11 } });
    const dItem = (compD.result || []).find((i) => i.label === ".loop");
    const dEdit = dItem && dItem.textEdit;
    ok(
        !!dEdit && dEdit.newText === ".loop" && dEdit.range.start.character === 8 && dEdit.range.end.character === 11,
        "dot-label textEdit covers the dot"
    );
    const compSize = await c.req("textDocument/completion", { textDocument: { uri: uUri }, position: { line: 4, character: 21 } });
    ok((compSize.result || []).some((i) => i.label === "Button_size"), "synthesized Button_size completes");
    const hovM = await c.req("textDocument/hover", { textDocument: { uri: uUri }, position: { line: 3, character: 26 } });
    const hvM = (hovM.result && hovM.result.contents && hovM.result.contents.value) || "";
    ok(hvM.includes("Button.w") && hvM.includes("offset 4") && hvM.includes("dword"), "member hover shows offset + size: " + hvM.split("\n").slice(0, 6).join(" | "));
    ok(hvM.includes("s.asm"), "member hover shows origin file");
    const defM = await c.req("textDocument/definition", { textDocument: { uri: uUri }, position: { line: 3, character: 26 } });
    ok(defM.result && defM.result.uri === `file://${WS}/s.asm` && defM.result.range.start.line === 2, "goto-def jumps to member: " + JSON.stringify(defM.result));

    // data symbols: bss/data reserves complete, hover, and jump
    fs.writeFileSync(
        `${WS}/d.asm`,
        ["section .bss", "    screen_num resb 4", "section .data", '    windowtitle db "Paint",0', "global shareme", "global screen_num", "global windowtitle", "shareme:", "    mov eax, [screen_num]", "    ret", ""].join("\n")
    );
    const eText = ["extern shareme", "extern screen_num", "extern windowtitle", "    mov eax, [screen_num]", "    lea rdi, [windowtitle]", ""].join("\n");
    fs.writeFileSync(`${WS}/e.asm`, eText);
    const ddUri = `file://${WS}/d.asm`;
    const eeUri = `file://${WS}/e.asm`;
    c.notify("textDocument/didOpen", { textDocument: { uri: ddUri, languageId: "nasm", version: 1, text: fs.readFileSync(`${WS}/d.asm`, "utf8") } });
    c.notify("textDocument/didOpen", { textDocument: { uri: eeUri, languageId: "nasm", version: 1, text: eText } });
    await new Promise((r) => setTimeout(r, 400));
    const compS = await c.req("textDocument/completion", { textDocument: { uri: eeUri }, position: { line: 3, character: 20 } });
    const sItem = (compS.result || []).find((i) => i.label === "screen_num");
    ok(!!sItem && sItem.detail === "global — d.asm", "workspace data reserve completes");
    const hovS = await c.req("textDocument/hover", { textDocument: { uri: eeUri }, position: { line: 3, character: 16 } });
    const hvS = (hovS.result && hovS.result.contents && hovS.result.contents.value) || "";
    ok(hvS.includes("screen_num") && hvS.includes("4 bytes"), "data hover shows size");
    const defS = await c.req("textDocument/definition", { textDocument: { uri: eeUri }, position: { line: 3, character: 16 } });
    ok(defS.result && defS.result.uri === ddUri && defS.result.range.start.line === 1, "goto-def jumps to resb: " + JSON.stringify(defS.result));
    const hovW = await c.req("textDocument/hover", { textDocument: { uri: eeUri }, position: { line: 4, character: 16 } });
    const hvW = (hovW.result && hovW.result.contents && hovW.result.contents.value) || "";
    ok(hvW.includes("windowtitle"), "db hover resolves cross-file");
    const hovLocal = await c.req("textDocument/hover", { textDocument: { uri: ddUri }, position: { line: 8, character: 16 } });
    const hvLocal = (hovLocal.result && hovLocal.result.contents && hovLocal.result.contents.value) || "";
    ok(hvLocal.includes("screen_num") && hvLocal.includes("4 bytes"), "same-file data hover");

    // stack pairing: unbalanced function errors without save (as-you-type)
    const stUri = `file://${WS}/st.asm`;
    c.notify("textDocument/didOpen", {
        textDocument: { uri: stUri, languageId: "nasm", version: 1, text: "draw:\n    push rbx\n    push r12\n    ret\n" },
    });
    const st = await new Promise((res, rej) => {
        const t0 = Date.now();
        const poll = () => {
            const matches = c.notes.filter((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === stUri);
            const hit = matches.find((n) => n.params.diagnostics.some((d) => d.severity === 1 && /never popped|matching pop/.test(d.message)));
            if (hit) {
                return res(hit.params.diagnostics);
            }
            if (Date.now() - t0 > 8000) {
                return rej(new Error("timeout stack"));
            }
            setTimeout(poll, 50);
        };
        poll();
    });
    ok(st.length >= 2, "stack imbalance reported as-you-type");

    // semantic pair tokens: pushes 0..2, pops mirror 2..0
    const sem = await c.req("textDocument/semanticTokens/full", { textDocument: { uri: stUri } });
    const data = (sem.result && sem.result.data) || [];
    const byLine = new Map();
    let line = 0;
    let ch = 0;
    for (let i = 0; i + 4 < data.length + 1; i += 5) {
        const dl = data[i];
        const dc = data[i + 1];
        line += dl;
        ch = dl === 0 ? ch + dc : dc;
        const mods = data[i + 4];
        byLine.set(line, Math.round(Math.log2(mods)));
    }
    // st.asm: draw: / push rbx / push r12 / ret  -> pairs 0,1 ; ret has none
    ok(byLine.get(1) === 0 && byLine.get(2) === 1, "pushes get successive pair colors");
    ok(!byLine.has(3), "ret gets no pair token");

    // conflict: duplicate global in new file
    fs.writeFileSync(`${WS}/c.asm`, ["global calcStrExpr", "calcStrExpr:", "    ret", ""].join("\n"));
    c.notify("textDocument/didOpen", {
        textDocument: { uri: `file://${WS}/c.asm`, languageId: "nasm", version: 1, text: fs.readFileSync(`${WS}/c.asm`, "utf8") },
    });
    await new Promise((r) => setTimeout(r, 400));
    c.notes.length = 0;
    c.notify("textDocument/didSave", { textDocument: { uri: `file://${WS}/c.asm` } });
    const dc = await new Promise((res, rej) => {
        const t0 = Date.now();
        const poll = () => {
            const i = c.notes.findIndex((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === `file://${WS}/c.asm`);
            if (i >= 0) {
                return res(c.notes.splice(i, 1)[0].params.diagnostics);
            }
            if (Date.now() - t0 > 8000) {
                return rej(new Error("timeout conflict"));
            }
            setTimeout(poll, 50);
        };
        poll();
    });
    ok(dc.some((d) => d.severity === 1 && /multiple definition.*a\.asm/.test(d.message)), "multiple-definition error");
    c.proc.kill();
}


// ---------------------------------------------------------------- debugger
// A tiny DAP client so the debug adapter can be exercised without VS Code.
class TestDapClient {
    constructor(adapter) {
        this.proc = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "pipe"] });
        this.buffer = Buffer.alloc(0);
        this.seq = 1;
        this.pending = new Map();
        this.events = [];
        this.waiters = [];
        this.terminalProcs = [];
        this.stderr = "";
        this.proc.stdout.on("data", (d) => this.onData(d));
        this.proc.stderr.on("data", (d) => (this.stderr += d.toString()));
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) break;
            const header = this.buffer.slice(0, headerEnd).toString();
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) break;
            const length = parseInt(match[1], 10);
            if (this.buffer.length < headerEnd + 4 + length) break;
            const message = JSON.parse(this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString());
            this.buffer = this.buffer.slice(headerEnd + 4 + length);
            if (message.type === "response") {
                const resolve = this.pending.get(message.request_seq);
                if (resolve) {
                    this.pending.delete(message.request_seq);
                    resolve(message);
                }
            } else if (message.type === "event") {
                this.events.push(message);
                for (const waiter of [...this.waiters]) {
                    if (waiter.match(message)) {
                        this.waiters.splice(this.waiters.indexOf(waiter), 1);
                        const index = this.events.indexOf(message);
                        if (index >= 0) this.events.splice(index, 1);
                        waiter.resolve(message);
                    }
                }
            } else if (message.type === "request" && message.command === "runInTerminal") {
                const args = message.arguments.args || [];
                const child = spawn(args[0], args.slice(1), {
                    cwd: message.arguments.cwd,
                    detached: true,
                    stdio: "ignore",
                });
                this.terminalProcs.push(child);
                this.respond(message, { processId: child.pid });
            }
        }
    }
    respond(request, body) {
        const message = {
            seq: this.seq++,
            type: "response",
            request_seq: request.seq,
            success: true,
            command: request.command,
            body,
        };
        this.write(message);
    }
    write(message) {
        const text = JSON.stringify(message);
        this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    }
    send(command, args) {
        const seq = this.seq++;
        const message = { seq, type: "request", command };
        if (args) message.arguments = args;
        return new Promise((resolve, reject) => {
            this.pending.set(seq, resolve);
            this.write(message);
            setTimeout(() => {
                if (this.pending.has(seq)) {
                    this.pending.delete(seq);
                    reject(new Error(`DAP ${command} timed out`));
                }
            }, 15000);
        });
    }
    waitForEvent(predicate, timeout = 15000) {
        const existing = this.events.find(predicate);
        if (existing) {
            this.events.splice(this.events.indexOf(existing), 1);
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const waiter = { match: predicate, resolve };
            this.waiters.push(waiter);
            setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) {
                    this.waiters.splice(index, 1);
                    reject(new Error("timed out waiting for DAP event"));
                }
            }, timeout);
        });
    }
    cleanup() {
        for (const child of this.terminalProcs) {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                try {
                    child.kill("SIGKILL");
                } catch {
                    // ignore
                }
            }
        }
        try {
            this.proc.kill("SIGKILL");
        } catch {
            // ignore
        }
    }
}

async function debuggerTests() {
    const G = require(path.join(ROOT, "out", "gdb.js"));
    const record = G.parseMiRecord(
        '7^done,stack=[frame={level="0",addr="0x401000",func="main"},frame={level="1",addr="0x1"}],register-names=["rax","rbx"]'
    );
    ok(
        record && record.token === 7 && record.className === "done" && record.results.stack.length === 2,
        "MI record parses result lists"
    );
    ok(
        record.results.stack[0].func === "main" && record.results["register-names"][1] === "rbx",
        "MI values parse tuples/strings"
    );
    const stream = G.parseMiRecord('~"hello\\n"');
    ok(stream && stream.stream === "hello\n", "MI console stream unescapes");
    ok(G.miString('"a b"') === '"a b"', "MI bare string is untouched");

    const gdb = spawnSync("gdb", ["--version"]);
    const nasm = spawnSync("nasm", ["-v"]);
    const ld = spawnSync("ld", ["--version"]);
    const gdbserver = spawnSync("gdbserver", ["--version"]);
    if (gdb.status !== 0 || nasm.status !== 0 || ld.status !== 0 || gdbserver.status !== 0) {
        console.log("skip: gdb/nasm/ld/gdbserver not all installed");
        return;
    }

    const dir = "/tmp/opencode/nasm-ide-debug-test";
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, "test.asm");
    const program = path.join(dir, "test");
    fs.writeFileSync(
        source,
        [
            "default rel",
            "global _start",
            "section .text",
            "_start:",
            "    mov r12, 5",
            "    mov r13, 7",
            ".loop:",
            "    dec r12",
            "    jnz .loop",
            "    mov eax, 60",
            "    xor edi, edi",
            "    syscall",
            "section .data",
            "    TestValue dd 0x1234",
            '    TestString db "hi", 0',
            "section .bss",
            "    TestBuf resb 4",
            "    TestGroup:",
            "        .a resw 1",
            "        .b resw 1",
            "",
        ].join("\n")
    );
    execFileSync("nasm", ["-f", "elf64", "-g", "-F", "dwarf", source, "-o", path.join(dir, "test.o")]);
    execFileSync("ld", ["-o", program, path.join(dir, "test.o")]);

    const adapter = path.join(ROOT, "out", "debugAdapter.js");
    const client = new TestDapClient(adapter);
    try {
        let response = await client.send("initialize", {
            adapterID: "nasm",
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: "path",
        });
        ok(response.success, "debug initialize");
        response = await client.send("launch", {
            program,
            cwd: dir,
            console: "internalConsole",
            stopOnEntry: false,
            args: [],
        });
        ok(response.success, "debug launch (internalConsole)");
        await client.waitForEvent((e) => e.event === "initialized");
        response = await client.send("setBreakpoints", {
            source: { path: source },
            breakpoints: [{ line: 8 }],
        });
        ok(response.body.breakpoints[0].verified === true, "debug source breakpoint verified");
        response = await client.send("configurationDone", {});
        ok(response.success, "debug configurationDone");

        let stopped = await client.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "breakpoint", "debug stops at breakpoint");
        ok((stopped.body.hitBreakpointIds || []).length === 1, "debug reports breakpoint id");

        response = await client.send("threads", {});
        ok(response.body.threads.length >= 1, "debug threads");
        response = await client.send("stackTrace", { threadId: 1, startFrame: 0, levels: 4 });
        const frame = response.body.stackFrames[0];
        ok(frame.name.includes("_start.loop") && frame.line === 8, "debug stack frame has asm symbol/line");
        ok(/^0x[0-9a-f]+$/i.test(frame.instructionPointerReference), "debug frame has instruction pointer");

        response = await client.send("scopes", { frameId: frame.id });
        const scopes = response.body.scopes;
        const registersRef = scopes.find((s) => s.name === "Registers").variablesReference;
        const flagsRef = scopes.find((s) => s.name === "Flags").variablesReference;
        const stackRef = scopes.find((s) => s.name === "Stack (rsp)").variablesReference;
        response = await client.send("variables", { variablesReference: registersRef });
        const registers = Object.fromEntries(response.body.variables.map((v) => [v.name, v.value]));
        ok(
            registers.r12.startsWith("0x5") &&
                registers.r12.includes("(5)") &&
                registers.r13.startsWith("0x7"),
            "debug registers r12/r13"
        );
        ok(
            /^0x7[0-9a-f]+\s+\(\d+\)\s+\[rsp % 16 = \d+(?:, aligned)?\]/i.test(registers.rsp),
            "debug rsp register and alignment"
        );
        const rspAddress = registers.rsp.match(/^0x[0-9a-f]+/i)[0];
        response = await client.send("setVariable", {
            variablesReference: registersRef,
            name: "r13",
            value: "42",
        });
        ok(
            response.success &&
                response.body.value.startsWith("0x2a") &&
                response.body.value.includes("(42)") &&
                response.body.value.includes("'*'"),
            "debug set register"
        );
        response = await client.send("variables", { variablesReference: registersRef });
        const changedRegisters = Object.fromEntries(response.body.variables.map((v) => [v.name, v.value]));
        ok(
            changedRegisters.r13.startsWith("0x2a") &&
                changedRegisters.r13.includes("(42)") &&
                changedRegisters.r13.includes("'*'"),
            "debug set register is live"
        );
        response = await client.send("setVariable", {
            variablesReference: registersRef,
            name: "r13",
            value: changedRegisters.r13,
        });
        ok(response.success && response.body.value.includes("(42)"), "debug edit annotated register");
        response = await client.send("variables", { variablesReference: flagsRef });
        const flags = Object.fromEntries(response.body.variables.map((v) => [v.name, v.value]));
        ok(flags.RFLAGS && flags.CF !== undefined && flags.ZF !== undefined, "debug flags decoded");
        response = await client.send("variables", { variablesReference: stackRef });
        ok(
            response.body.variables.some((v) => v.name === "[rsp+0x00]" && /^0x[0-9a-f]+$/.test(v.value)),
            "debug stack qwords"
        );
        const dataRef = scopes.find((s) => s.name === "Data (.data/.bss)").variablesReference;
        response = await client.send("variables", { variablesReference: dataRef });
        const dataVariables = response.body.variables;
        const data = Object.fromEntries(dataVariables.map((v) => [v.name, v.value]));
        ok(data.TestValue && data.TestValue.includes("0x1234"), "debug .data scalar value");
        ok(data.TestString && data.TestString.includes("hi"), "debug .data string value");
        ok(data.TestBuf && data.TestBuf.includes("0x0"), "debug .bss value");
        const stringVariable = dataVariables.find((v) => v.name === "TestString");
        ok(stringVariable && stringVariable.variablesReference > 0, "debug data variable expands");
        response = await client.send("variables", { variablesReference: stringVariable.variablesReference });
        ok(
            response.body.variables.some((v) => v.name === "+0x0000" && v.value.includes("68 69 00")),
            "debug data byte expansion"
        );
        const groupVariable = dataVariables.find((v) => v.name === "TestGroup");
        ok(groupVariable && groupVariable.value === "{2 fields}", "debug data struct group");
        response = await client.send("variables", { variablesReference: groupVariable.variablesReference });
        ok(
            response.body.variables.map((v) => v.name).join(",") === ".a,.b",
            "debug data struct fields"
        );

        response = await client.send("setVariable", {
            variablesReference: dataRef,
            name: "TestValue",
            value: "0x5678",
        });
        ok(response.success && response.body.value.includes("0x5678"), "debug set .data scalar");
        response = await client.send("setVariable", {
            variablesReference: dataRef,
            name: "TestString",
            value: '"bye"',
        });
        ok(response.success && response.body.value.includes("bye"), "debug set .data string");
        response = await client.send("setVariable", {
            variablesReference: dataRef,
            name: "TestBuf",
            value: "de ad be ef",
        });
        ok(response.success && response.body.value.includes("0xde"), "debug set .bss bytes");
        response = await client.send("setVariable", {
            variablesReference: groupVariable.variablesReference,
            name: ".a",
            value: "0x1234",
        });
        ok(response.success && response.body.value.includes("0x1234"), "debug set struct field");
        response = await client.send("variables", { variablesReference: stringVariable.variablesReference });
        const stringRow = response.body.variables.find((v) => v.name === "+0x0000");
        response = await client.send("setVariable", {
            variablesReference: stringVariable.variablesReference,
            name: "+0x0000",
            value: "62 79 65",
        });
        ok(response.success && response.body.value.includes("62 79 65"), "debug set data byte row");
        response = await client.send("variables", { variablesReference: dataRef });
        const updatedData = Object.fromEntries(response.body.variables.map((v) => [v.name, v.value]));
        ok(updatedData.TestValue.includes("0x5678"), "debug set .data is live");
        ok(updatedData.TestString.includes("bye") && stringRow, "debug byte row is live");

        response = await client.send("evaluate", { expression: "$r12", context: "watch" });
        ok(response.body.result === "5", "debug evaluate register");
        response = await client.send("disassemble", {
            memoryReference: frame.instructionPointerReference,
            offset: 0,
            instructionOffset: 0,
            instructionCount: 4,
            resolveSymbols: true,
        });
        ok(
            response.body.instructions.length >= 2 && /dec/i.test(response.body.instructions[0].instruction),
            "debug disassembly at rip"
        );
        response = await client.send("readMemory", {
            memoryReference: rspAddress,
            offset: 0,
            count: 16,
        });
        ok(
            response.body.data && Buffer.from(response.body.data, "base64").length === 16,
            "debug read memory"
        );

        response = await client.send("next", { threadId: 1, granularity: "instruction" });
        ok(response.success, "debug next instruction");
        stopped = await client.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "step", "debug step stop reason");

        response = await client.send("restart", {});
        ok(response.success, "debug restart");
        stopped = await client.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "breakpoint", "debug breakpoint survives restart");

        response = await client.send("disconnect", { terminateDebuggee: true });
        ok(response.success, "debug disconnect");
    } finally {
        client.cleanup();
    }

    // Terminal/gdbserver path: the fake client starts gdbserver for runInTerminal.
    const terminalClient = new TestDapClient(adapter);
    try {
        let response = await terminalClient.send("initialize", {
            adapterID: "nasm",
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: "path",
        });
        ok(response.success, "terminal debug initialize");
        response = await terminalClient.send("launch", {
            program,
            cwd: dir,
            console: "integratedTerminal",
            stopOnEntry: true,
            args: [],
        });
        ok(response.success, "terminal debug launch via gdbserver");
        await terminalClient.waitForEvent((e) => e.event === "initialized");
        response = await terminalClient.send("setBreakpoints", {
            source: { path: source },
            breakpoints: [{ line: 8 }],
        });
        ok(response.body.breakpoints[0].verified === true, "terminal breakpoint verified");
        await terminalClient.send("configurationDone", {});
        let stopped = await terminalClient.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "entry", "terminal gdbserver stops at entry");
        response = await terminalClient.send("continue", { threadId: 1 });
        stopped = await terminalClient.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "breakpoint", "terminal gdbserver reaches breakpoint");
        response = await terminalClient.send("evaluate", { expression: "$r12", context: "watch" });
        ok(response.body.result === "5", "terminal gdbserver register read");
        response = await terminalClient.send("disconnect", { terminateDebuggee: true });
        ok(response.success, "terminal debug disconnect");
    } finally {
        terminalClient.cleanup();
    }

    // Stop while the inferior is running: the terminal's gdbserver must exit
    // too, otherwise it keeps the terminal busy and blocks the next launch.
    const runningSource = path.join(dir, "running.asm");
    const runningProgram = path.join(dir, "running");
    fs.writeFileSync(
        runningSource,
        [
            "global _start",
            "section .text",
            "_start:",
            "    mov r12, 5",
            ".loop:",
            "    inc r12",
            "    jmp .loop",
            "",
        ].join("\n")
    );
    execFileSync("nasm", ["-f", "elf64", "-g", "-F", "dwarf", runningSource, "-o", path.join(dir, "running.o")]);
    execFileSync("ld", ["-o", runningProgram, path.join(dir, "running.o")]);

    const runningClient = new TestDapClient(adapter);
    try {
        let response = await runningClient.send("initialize", {
            adapterID: "nasm",
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: "path",
        });
        ok(response.success, "running stop initialize");
        response = await runningClient.send("launch", {
            program: runningProgram,
            cwd: dir,
            console: "integratedTerminal",
            stopOnEntry: true,
            args: [],
        });
        ok(response.success, "running stop launch via gdbserver");
        await runningClient.waitForEvent((e) => e.event === "initialized");
        response = await runningClient.send("setBreakpoints", {
            source: { path: runningSource },
            breakpoints: [{ line: 5 }],
        });
        ok(response.body.breakpoints[0].verified === true, "running stop breakpoint verified");
        await runningClient.send("configurationDone", {});
        let stopped = await runningClient.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "entry", "running stop stops at entry");
        await runningClient.send("continue", { threadId: 1 });
        stopped = await runningClient.waitForEvent((e) => e.event === "stopped");
        ok(stopped.body.reason === "breakpoint", "running stop reaches breakpoint");
        await runningClient.send("continue", { threadId: 1 });
        await new Promise((r) => setTimeout(r, 200));

        response = await runningClient.send("disconnect", { terminateDebuggee: true });
        ok(response.success, "running stop disconnect");
        const gdbserverChild = runningClient.terminalProcs[0];
        const exited = await waitForExit(gdbserverChild, 8000);
        ok(exited, "gdbserver exits when stopped while the target is running");
    } finally {
        runningClient.cleanup();
    }
}

function waitForExit(child, timeout) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeout);
        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };
        child.once("exit", onExit);
    });
}

(async () => {
    try {
        unit();
        await integration();
        await debuggerTests();
    } catch (e) {
        console.error("HARNESS ERROR:", e);
        fails++;
    }
    console.log(fails ? `${fails} FAILURES` : "ALL TESTS PASS");
    process.exit(fails ? 1 : 0);
})();
