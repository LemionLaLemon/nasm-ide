// Headless test for the client (out/extension.js): task provider command
// construction + pickLibraries flow, with stubbed vscode/languageclient.
const Module = require("module");
const path = require("path");

const calls = { configUpdates: [], picks: null };
const canned = {
    "nasmIde.nasmPath": "nasm",
    "nasmIde.arch": "x86_64",
    "nasmIde.libraries": ["c", "m"],
    "nasmIde.build.linker": "ld",
    "nasmIde.build.sources": ["src/*.asm"],
    "nasmIde.build.objDir": "obj",
    "nasmIde.build.output": "bin/${workspaceFolderBasename}",
    "nasmIde.build.extraLdFlags": ["-dynamic-linker", "/lib64/ld-linux-x86-64.so.2"],
};

class FakeTask {
    constructor(definition, scope, name, source, execution, problemMatchers) {
        Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
    }
}
const vscodeStub = {
    workspace: {
        workspaceFolders: [{ name: "calcengine", uri: { fsPath: "/tmp/nasmtask" } }],
        getConfiguration: undefined,
        findFiles: async () => [{ fsPath: "/tmp/nasmtask/src/a.asm" }, { fsPath: "/tmp/nasmtask/src/b.asm" }],
        createFileSystemWatcher: () => ({ dispose() {} }),
    },
    commands: { registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; } },
    tasks: { registerTaskProvider: (type, provider) => { vscodeStub._provider = provider; return { dispose() {} }; } },
    window: {
        showQuickPick: async (items) => {
            calls.picks = items.map((i) => i.label);
            return items.filter((i) => i.flag === "c" || i.flag === "X11");
        },
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        showErrorMessage: () => {},
    },
    Task: FakeTask,
    TaskGroup: { Build: "build" },
    ShellExecution: class {
        constructor(command, options) {
            this.command = typeof command === "string" ? command : command;
            this.options = options;
        }
    },
    RelativePattern: class {
        constructor(folder, pattern) {
            this.folder = folder;
            this.pattern = pattern;
        }
    },
    TaskRevealKind: { Always: 1 },
    ConfigurationTarget: { Workspace: 1, WorkspaceFolder: 2 },
    _cmds: {},
    _provider: null,
};
// getConfiguration with section-aware canned values
vscodeStub.workspace.getConfiguration = (section) => ({
    get: (key, dflt) => {
        const v = canned[`${section}.${key}`];
        return v === undefined ? dflt : v;
    },
    update: async (key, value) => {
        calls.configUpdates.push([`${section}.${key}`, value]);
    },
});

class FakeClient {
    constructor() {
        FakeClient.last = this;
    }
    start() {
        this.running = true;
    }
    isRunning() {
        return !!this.running;
    }
    async sendRequest(method) {
        if (method === "nasmIde/listLibraryCandidates") {
            return [
                { flag: "c", path: "/usr/lib/libc.so", description: "/usr/lib/libc.so" },
                { flag: "m", path: "/usr/lib/libm.so", description: "/usr/lib/libm.so" },
                { flag: "X11", path: "/usr/lib/libX11.so", description: "/usr/lib/libX11.so" },
            ];
        }
        throw new Error("unexpected " + method);
    }
}
const lcStub = { LanguageClient: FakeClient, TransportKind: { ipc: 1 } };

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "vscode") {
        return vscodeStub;
    }
    if (request === "vscode-languageclient/node") {
        return lcStub;
    }
    return origLoad.call(this, request, ...rest);
};

let fails = 0;
const ok = (c, m) => {
    console.log((c ? "ok: " : "FAIL: ") + m);
    if (!c) {
        fails++;
    }
};

(async () => {
    const ext = require(path.join(__dirname, "..", "out", "extension.js"));
    ext.activate({ asAbsolutePath: (p) => p, subscriptions: [] });

    const tasks = await vscodeStub._provider.provideTasks();
    ok(tasks.length === 3, "three tasks provided");
    const build = tasks.find((t) => t.definition.operation === "build");
    const run = tasks.find((t) => t.definition.operation === "run");
    const clean = tasks.find((t) => t.definition.operation === "clean");
    const cmd = build.execution.command;
    console.log("  build cmd:", cmd);
    ok(cmd.includes("nasm -f elf64 -g -F dwarf"), "nasm with debug flags");
    ok(cmd.includes("src/a.asm") && cmd.includes("src/b.asm"), "both sources assembled");
    ok(cmd.includes("ld -o bin/calcengine"), "ld output with substituted folder name");
    ok(cmd.includes("-lc") && cmd.includes("-lm"), "libraries linked");
    ok(cmd.includes("-dynamic-linker /lib64/ld-linux-x86-64.so.2"), "extra ld flags");
    ok(JSON.stringify(build.problemMatchers).includes("$gcc"), "gcc problem matcher");
    ok(run.execution.command.endsWith("bin/calcengine"), "run executes output: " + run.execution.command);
    ok(clean.execution.command.includes("rm -rf"), "clean removes artifacts");

    await vscodeStub._cmds["nasmIde.pickLibraries"]();
    ok(calls.picks.length === 3 && calls.picks[0] === "-lc", "picker lists -l flags");
    const update = calls.configUpdates.find(([k]) => k === "nasmIde.libraries");
    ok(update && update[1].join() === "c,X11", "picker saves workspace libraries: " + JSON.stringify(update && update[1]));

    await vscodeStub._cmds["nasmIde.toggleDiagnostics"]();
    const tog = calls.configUpdates.find(([k]) => k === "nasmIde.diagnostics.enable");
    ok(tog && tog[1] === false, "toggle flips diagnostics.enable");

    const pkg = require(path.join(__dirname, "..", "package.json"));
    const props = pkg.contributes.configuration.properties;
    ok(props["nasmIde.libraries"].scope === "resource", "libraries allows folder scope");
    for (const k of Object.keys(props).filter((x) => x.startsWith("nasmIde.build."))) {
        ok(props[k].scope === "resource", `${k} allows folder scope`);
    }

    console.log(fails ? `${fails} FAILURES` : "CLIENT TESTS PASS");
    process.exit(fails ? 1 : 0);
})().catch((e) => {
    console.error("HARNESS ERROR:", e);
    process.exit(2);
});
