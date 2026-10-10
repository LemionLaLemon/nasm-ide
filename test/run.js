// nasm-ide test suite: unit + LSP integration. Run with `npm test`.
const { spawn, execSync } = require("child_process");
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
    ok(D.getInstructionCompletions("").length === 192, "192 instructions");
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

    const L = require(path.join(SERVER_OUT, "libscan.js"));
    const cache = L.ldconfigMap();
    ok(cache.size > 100, `ldconfig entries (${cache.size})`);
    const libc = L.resolveLibrary("c");
    ok(!!libc && fs.existsSync(libc), "resolve -lc: " + libc);
    ok(L.resolveLibrary("definitely_not_a_lib_xyz") === null, "unknown lib -> null");
    const syms = L.nmDefinedSymbols(libc);
    ok(syms.has("printf") && syms.has("malloc") && syms.has("strtod"), "libc exports parsed");
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
    const proc = spawn("node", [serverJs, "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...extraEnv } });
    let buf = Buffer.alloc(0);
    const pending = new Map();
    let id = 0;
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

    const c = lspClient(path.join(SERVER_OUT, "server.js"));
    const cannedSettings = {
        nasmPath: "nasm",
        arch: "x86_64",
        diagnostics: { enable: true, mode: "asYouType", debounceMs: 100, unresolvedExterns: true },
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
    await new Promise((r) => setTimeout(r, 600));

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

(async () => {
    try {
        unit();
        await integration();
    } catch (e) {
        console.error("HARNESS ERROR:", e);
        fails++;
    }
    console.log(fails ? `${fails} FAILURES` : "ALL TESTS PASS");
    process.exit(fails ? 1 : 0);
})();
