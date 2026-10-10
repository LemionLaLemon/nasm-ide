// Grammar tests: structure + functional regex checks for nasm.tmLanguage.json.
// NOTE: TextMate runs Oniguruma (?i supported); node does not, so (?i) is
// mapped to the Regexp i-flag purely for behavioral validation here.
const fs = require("fs");
const path = require("path");

let fails = 0;
const ok = (c, m) => {
    console.log((c ? "ok: " : "FAIL: ") + m);
    if (!c) {
        fails++;
    }
};

const G = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "syntaxes", "nasm.tmLanguage.json"), "utf8"));
const toJs = (src) => new RegExp(src.replace(/\(\?i\)/g, ""), "i");
const firstMatch = (rules, line) => {
    for (const rule of rules) {
        if (!rule.match) {
            continue;
        }
        const m = toJs(rule.match).exec(line);
        if (m && m.index === 0) {
            return rule;
        }
    }
    return null;
};

const labelScope = G.repository.label.patterns[0].name;
ok(labelScope === "entity.name.function.nasm", "labels scoped as functions (theme yellow): " + labelScope);

const order = G.patterns.map((p) => p.include);
ok(order[order.length - 1] === "#symbol", "catch-all symbol rule is last: " + order.join(","));
ok(G.repository.symbol.patterns[0].name === "entity.name.function.nasm", "symbols scoped as functions");

const ordered = ["comment", "label", "directive", "instruction", "register", "number", "string", "operator", "symbol"].flatMap(
    (k) => G.repository[k].patterns
);
// label definitions keep their scope incl. local labels + indent
for (const line of ["buttons:", "  print:", ".loop:", "\t.PeekToken:"]) {
    const r = firstMatch(ordered, line);
    ok(r && r.name === "entity.name.function.nasm", `label def: ${JSON.stringify(line)}`);
}
// symbol references fall through to the catch-all
const sym = G.repository.symbol.patterns[0];
for (const word of ["parse_cursor", ".data", "XDefaultRootWindow", "btn_w", "calcStrExpr", "rel", "dword"]) {
    ok(toJs(sym.match).test(word), `symbol ref matches: ${word}`);
}
// real rules still win over the catch-all at the same position
const at = (line) => {
    for (const rule of ordered) {
        if (!rule.match) {
            continue;
        }
        const m = toJs(rule.match).exec(line);
        if (m && m.index === 0) {
            return rule.name || "(capture rule)";
        }
    }
    return "(none)";
};
ok(at("mov eax, 1").includes("instruction"), "mov still instruction");
ok(at("rax").includes("register"), "rax still register");
ok(at("0x10").includes("numeric"), "0x10 still number");
ok(at("; comment").includes("comment"), "comments still comments");
ok(at("section").includes("directive"), "section still directive keyword");
ok(at("%define").includes("directive"), "%define still directive keyword");
ok(at("inc eax, 1").includes("instruction"), "inc is an instruction, not a symbol");
ok(at("dec eax").includes("instruction"), "dec is an instruction, not a symbol");
for (const w of ["byte", "dword", "qword", "rel", "wrt", "strict"]) {
    ok(at(w).includes("operator"), `${w} is an operator keyword, not a symbol`);
}

console.log(fails ? `${fails} FAILURES` : "GRAMMAR TESTS PASS");
process.exit(fails ? 1 : 0);
