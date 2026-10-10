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

    const D = require(path.join(SERVER_OUT, "libcData.js"));
    const all = D.getLibcCompletions("");
    ok(all.length >= 50, `libc dataset (${all.length})`);
    ok(D.getLibcFunction("printf").signature.includes("const char *format"), "printf signature");
    const r = D.renderLibcFunction(D.getLibcFunction("printf"));
    ok(r.includes("`rdi` - format") && r.includes("`rax` - number of vector") && r.includes("clobber"), "printf ABI render");
    const s = D.renderLibcFunction(D.getLibcFunction("sqrt"));
    ok(s.includes("`xmm0` - x:") && s.includes("-lm"), "sqrt uses xmm0 + lm hint");
    const f = D.renderLibcFunction(D.getLibcFunction("free"));
    ok(!f.includes("**Returns**") && f.includes("`rdi` - ptr"), "void fn has no Returns");

    const { LibraryIndex } = require(path.join(SERVER_OUT, "libraries.js"));
    const idx = new LibraryIndex();
    ok(idx.ensure(["c"]) === true, "index builds");
    ok(idx.ensure(["c"]) === false, "index cached");
    ok(idx.provides("printf") && !idx.provides("totally_made_up_xyz"), "provides()");
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
            } else if (msg.method) {
                notes.push(msg);
            }
        }
    });
    const send = (m) => {
        const s = JSON.stringify(m);
        proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
    };
    return {
        proc,
        notes,
        req: (method, params) =>
            new Promise((res) => {
                const i = ++id;
                pending.set(i, res);
                send({ jsonrpc: "2.0", id: i, method, params });
            }),
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    };
}

async function integration() {
    const WS = "/tmp/opencode/asm-setup/nasmide-test";
    execSync(`rm -rf ${WS} && mkdir -p ${WS}`);
    const A = ["; Calculates.", "; @param rdi buf", "global calcStrExpr", "calcStrExpr:", "    ret", ""].join("\n");
    const B = ["extern calcStrExpr", "extern printf", "extern bogus_sym_xyz", "_start:", "    call calcStrExpr", "    ret", ""].join("\n");
    fs.writeFileSync(`${WS}/a.asm`, A);
    fs.writeFileSync(`${WS}/b.asm`, B);

    const c = lspClient(path.join(SERVER_OUT, "server.js"));
    await c.req("initialize", { processId: process.pid, rootUri: `file://${WS}`, capabilities: {} });
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
