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
const storageScopes = new Set(
    G.repository.directive.patterns.filter((r) => /d\[|res\[/.test(r.match || "")).map((r) => r.name)
);
ok(
    storageScopes.has(G.repository.operator.patterns[0].name),
    "sizes share dq/resq scope: " + G.repository.operator.patterns[0].name
);

const ordered = ["comment", "label", "directive", "push-pop", "instruction", "register", "number", "string", "operator", "symbol"].flatMap(
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
ok(at("push rbx").includes("push"), "push has its own scope");
ok(at("pop rax").includes("pop"), "pop has its own scope");
ok(at("pushfq").includes("push"), "pushfq scoped as push");
{
    const names = G.patterns.map((p) => p.include);
    ok(names.indexOf("#push-pop") < names.indexOf("#instruction"), "push/pop rules precede instructions");
}
for (const w of ["byte", "dword", "qword", "rel", "wrt", "strict"]) {
    ok(at(w).includes("storage.type.data"), `${w} shares the dq/resq storage color`);
}

// NASM single-quoted strings are literal: a backslash does not escape the
// closing quote. Treating it as an escape makes the rest of the file a string.
const stringRules = G.repository.string.patterns;
const quoteRule = (q) => stringRules.find((r) => r.begin === q && r.end === q);
const hasEscapes = (rule) => (rule.patterns || []).some((p) => p.name === "constant.character.escape.nasm");
const endsInString = (rule, line) => {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (!inString) {
            if (ch === rule.begin) inString = true;
        } else if (hasEscapes(rule) && ch === "\\") {
            i++;
        } else if (ch === rule.end) {
            inString = false;
        }
    }
    return inString;
};
const singleRule = quoteRule("'");
const doubleRule = quoteRule('"');
const backtickRule = quoteRule("`");
ok(singleRule && !hasEscapes(singleRule), "single-quoted strings do not use backslash escapes");
ok(doubleRule && hasEscapes(doubleRule), "double-quoted strings use backslash escapes");
ok(backtickRule && hasEscapes(backtickRule), "backtick strings use backslash escapes");
const shackLines = [
    "Shack:",
    "        db '  _______', 0",
    "        db ' /  LOG  \\', 0",
    "        db '/__SHACK__\\', 0",
    "        db ' |       |', 0",
    "        db ' |   _   |', 0",
    "        db ' |  | |  |', 0",
    "%define ShackX 20",
];
for (const [index, line] of shackLines.entries()) {
    ok(!endsInString(singleRule, line), `single-quoted string closes on shack line ${index + 1}`);
}
ok(!endsInString(doubleRule, 'db "a\\"b", 0'), "escaped double quote stays inside the string");

console.log(fails ? `${fails} FAILURES` : "GRAMMAR TESTS PASS");
process.exit(fails ? 1 : 0);
