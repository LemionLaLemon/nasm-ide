// NASM IDE client: language client, commands, and build/link task provider.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";

interface LibraryCandidate {
    flag: string;
    path?: string;
    description: string;
}

interface NasmIdeTaskDefinition extends vscode.TaskDefinition {
    operation: "build" | "run" | "clean" | "make";
}

let client: LanguageClient | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let asmWatcher: vscode.FileSystemWatcher | undefined;

function createClient(
    context: vscode.ExtensionContext,
    watcher: vscode.FileSystemWatcher
): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join("server", "out", "server.js"));
    const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "nasm" },
            { scheme: "untitled", language: "nasm" },
        ],
        synchronize: {
            configurationSection: "nasmIde",
            fileEvents: watcher,
        },
    };
    return new LanguageClient("nasmIde", "NASM IDE Language Server", serverOptions, clientOptions);
}

function reportStartFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
        `NASM IDE: language server failed to start (${message}). ` +
            "If VS Code was updated or its Electron binary replaced while running, fully quit and relaunch VS Code."
    );
}

function startClient(): Promise<boolean> {
    if (!client) {
        return Promise.resolve(false);
    }
    return Promise.resolve<unknown>(client.start()).then(
        () => true,
        (error) => {
            reportStartFailure(error);
            return false;
        }
    );
}

/** Recreate the client: after a failed start the old one refuses to restart. */
async function restartClient(): Promise<boolean> {
    if (!extensionContext || !asmWatcher) {
        return false;
    }
    if (client) {
        try {
            await client.stop();
        } catch {
            // startFailed/stopped clients throw here; a fresh client is the fix.
        }
        try {
            await client.dispose();
        } catch {
            // ignore: disposing a failed client can also throw
        }
    }
    client = createClient(extensionContext, asmWatcher);
    return startClient();
}

export function activate(context: vscode.ExtensionContext): void {
    extensionContext = context;
    asmWatcher = vscode.workspace.createFileSystemWatcher("**/*.{asm,nasm,inc}");
    const watcher = asmWatcher;
    client = createClient(context, watcher);

    context.subscriptions.push(
        vscode.commands.registerCommand("nasmIde.restartServer", async () => {
            const ok = await restartClient();
            void vscode.window.showInformationMessage(
                ok
                    ? "NASM IDE language server restarted."
                    : "NASM IDE language server could not be restarted. See the error notification."
            );
        }),
        vscode.commands.registerCommand("nasmIde.showServerStatus", () => {
            const running = client && client.isRunning();
            void vscode.window.showInformationMessage(
                running
                    ? "NASM IDE language server is running."
                    : "NASM IDE language server is not running."
            );
        }),
        vscode.commands.registerCommand("nasmIde.toggleDiagnostics", async () => {
            const config = vscode.workspace.getConfiguration("nasmIde");
            const current = config.get<boolean>("diagnostics.enable", true);
            await config.update("diagnostics.enable", !current, vscode.ConfigurationTarget.Workspace);
            void vscode.window.showInformationMessage(
                !current ? "NASM IDE diagnostics enabled." : "NASM IDE diagnostics disabled."
            );
        }),
        vscode.commands.registerCommand("nasmIde.pickLibraries", async () => {
            await pickLibraries();
        }),
        vscode.tasks.registerTaskProvider("nasm-ide", new NasmIdeTaskProvider()),
        vscode.debug.registerDebugConfigurationProvider(
            "nasm",
            new NasmDebugConfigurationProvider()
        ),
        watcher,
        { dispose: () => client?.stop() }
    );
    startClient();
}

async function pickLibraries(): Promise<void> {
    if (!client || !client.isRunning()) {
        void vscode.window.showWarningMessage("NASM IDE language server is not running.");
        return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        void vscode.window.showWarningMessage("Open a workspace folder to configure link libraries.");
        return;
    }
    let candidates: LibraryCandidate[];
    try {
        candidates = await client.sendRequest<LibraryCandidate[]>("nasmIde/listLibraryCandidates");
    } catch (err) {
        void vscode.window.showErrorMessage(`NASM IDE: could not scan link libraries: ${String(err)}`);
        return;
    }
    const folder = folders[0];
    const config = vscode.workspace.getConfiguration("nasmIde", folder.uri);
    const current = new Set(config.get<string[]>("libraries", ["c"]));
    const picked = await vscode.window.showQuickPick(
        candidates.map((c) => ({
            label: `-l${c.flag}`,
            description: c.path ?? c.description,
            picked: current.has(c.flag),
            flag: c.flag,
        })),
        {
            title: "NASM IDE: link libraries (-l flags, saved to this workspace)",
            canPickMany: true,
            matchOnDescription: true,
            placeHolder: "Search system libraries, e.g. \"X11\", \"m\", \"c\" ...",
        }
    );
    if (!picked) {
        return;
    }
    await config.update(
        "libraries",
        picked.map((p) => p.flag),
        vscode.ConfigurationTarget.WorkspaceFolder
    );
    void vscode.window.showInformationMessage(
        picked.length
            ? `NASM IDE: link libraries set to ${picked.map((p) => `-l${p.flag}`).join(" ")}.`
            : "NASM IDE: link library list cleared."
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

export function findMakefile(root: string): string | undefined {
    for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function substVars(value: string, folder: vscode.WorkspaceFolder): string {
    return value
        .replace(/\$\{workspaceFolderBasename\}/g, folder.name)
        .replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
}

class NasmIdeTaskProvider implements vscode.TaskProvider {
    public async provideTasks(): Promise<vscode.Task[]> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return [];
        }
        const tasks = [
            await this.buildTask(folder, "build"),
            await this.buildTask(folder, "run"),
            await this.buildTask(folder, "clean"),
        ];
        if (findMakefile(folder.uri.fsPath)) {
            tasks.push(await this.buildTask(folder, "make"));
        }
        return tasks;
    }

    public async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
        const def = task.definition as NasmIdeTaskDefinition;
        const folder =
            (task.scope as vscode.WorkspaceFolder | undefined) ?? vscode.workspace.workspaceFolders?.[0];
        if (
            !folder ||
            (def.operation !== "build" &&
                def.operation !== "run" &&
                def.operation !== "clean" &&
                def.operation !== "make")
        ) {
            return undefined;
        }
        return this.buildTask(folder, def.operation);
    }

    private async buildTask(
        folder: vscode.WorkspaceFolder,
        operation: "build" | "run" | "clean" | "make"
    ): Promise<vscode.Task> {
        const config = vscode.workspace.getConfiguration("nasmIde", folder.uri);
        const nasmPath = config.get<string>("nasmPath", "nasm");
        const arch = config.get<string>("arch", "x86_64");
        const format = arch === "x86_64" ? "elf64" : "elf32";
        const objDir = substVars(config.get<string>("build.objDir", "obj"), folder);
        const output = substVars(config.get<string>("build.output", "bin/${workspaceFolderBasename}"), folder);
        const linker = config.get<string>("build.linker", "ld");
        const libs = config.get<string[]>("libraries", ["c"]).map((l) => `-l${l}`);
        const extra = config.get<string[]>("build.extraLdFlags", []);
        const patterns = config.get<string[]>("build.sources", ["src/*.asm"]);
        const q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);

        let command: string;
        let problemMatchers: string[];
        let group: vscode.TaskGroup | undefined;
        if (operation === "make") {
            command = "make";
            problemMatchers = ["$gcc"];
            group = vscode.TaskGroup.Build;
        } else if (operation === "clean") {
            command = `rm -rf ${q(objDir)} ${q(output)}`;
            problemMatchers = [];
        } else {
            const matches = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, `{${patterns.join(",")}}`)
            );
            const sources = matches.map((u) => path.relative(folder.uri.fsPath, u.fsPath)).sort();
            const objects = sources.map((s) =>
                path.join(objDir, `${path.basename(s, path.extname(s))}.o`)
            );
            const assemble = sources.map(
                (s, i) =>
                    `${q(nasmPath)} -f ${format} -g -F dwarf ${q(s)} -o ${q(objects[i])}`
            );
            const linkInputs = objects.map(q).join(" ");
            const link =
                linker === "gcc"
                    ? `gcc -nostartfiles -no-pie -o ${q(output)} ${linkInputs} ${libs.map(q).join(" ")} ${extra.map(q).join(" ")}`
                    : `ld -o ${q(output)} ${linkInputs} ${libs.map(q).join(" ")} ${extra.map(q).join(" ")}`;
            if (operation === "build") {
                command = [`mkdir -p ${q(objDir)} ${q(path.dirname(output))}`, ...assemble, link]
                    .filter((c) => c.trim().length > 0)
                    .join(" && ");
            } else {
                command = q(path.isAbsolute(output) ? output : path.join(folder.uri.fsPath, output));
            }
            problemMatchers = operation === "build" ? ["$gcc"] : [];
            group = operation === "build" ? vscode.TaskGroup.Build : undefined;
        }
        const definition: NasmIdeTaskDefinition = { type: "nasm-ide", operation };
        const task = new vscode.Task(
            definition,
            folder,
            `NASM IDE: ${operation}`,
            "nasm-ide",
            new vscode.ShellExecution(command, { cwd: folder.uri.fsPath }),
            problemMatchers
        );
        if (group) {
            task.group = group;
        }
        if (operation === "run") {
            task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true };
        }
        return task;
    }
}

/**
 * Fills in launch defaults. The debug adapter itself only needs a program;
 * this makes the common cases (a Makefile in the workspace, or the extension's
 * own build task) work without hand-writing paths.
 */
class NasmDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    public provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        if (!folder) {
            return [];
        }
        const program = detectDebugProgram(folder) || "${workspaceFolder}/bin/${workspaceFolderBasename}";
        const hasMakefile = Boolean(findMakefile(folder.uri.fsPath));
        return [
            {
                type: "nasm",
                request: "launch",
                name: "Debug NASM program (gdb)",
                program,
                cwd: "${workspaceFolder}",
                console: "integratedTerminal",
                stopOnEntry: true,
                preLaunchTask: hasMakefile ? "NASM IDE: make" : "NASM IDE: build",
            },
            {
                type: "nasm",
                request: "attach",
                name: "Attach to gdbserver",
                host: "127.0.0.1",
                port: 1234,
                program,
                cwd: "${workspaceFolder}",
            },
        ];
    }

    public resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request) {
            config.type = "nasm";
            config.request = "launch";
            config.name = "Debug NASM program (gdb)";
        }
        const workspace = folder ?? vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            return config;
        }
        if (!config.cwd) {
            config.cwd = workspace.uri.fsPath;
        }
        if (!config.program && config.request !== "attach") {
            config.program = detectDebugProgram(workspace);
        }
        if (!config.program && config.request !== "attach") {
            void vscode.window.showErrorMessage(
                "NASM IDE: set \"program\" in launch.json to the built ELF file."
            );
            return undefined;
        }
        if (!config.console) {
            config.console = "integratedTerminal";
        }
        if (
            config.request === "launch" &&
            !config.preLaunchTask &&
            findMakefile(workspace.uri.fsPath)
        ) {
            config.preLaunchTask = "NASM IDE: make";
        }
        return config;
    }
}

function detectDebugProgram(folder: vscode.WorkspaceFolder): string | undefined {
    const root = folder.uri.fsPath;
    const makefile = findMakefile(root);
    if (makefile) {
        try {
            const text = fs.readFileSync(makefile, "utf8");
            const vars = parseMakeVariables(text);
            const expand = (value: string): string => {
                let out = value;
                for (let i = 0; i < 6; i++) {
                    const next = out.replace(/\$\(([^)]+)\)|\$\{([^}]+)\}/g, (_m, a, b) => {
                        return vars.get(a || b) ?? "";
                    });
                    if (next === out) {
                        break;
                    }
                    out = next;
                }
                return out.trim();
            };
            const candidates = [
                expand(vars.get("TARGET") || ""),
                expand(vars.get("OUTPUT") || ""),
                expand(vars.get("PROGRAM") || ""),
                [expand(vars.get("BUILD_DIR") || ""), expand(vars.get("APP") || vars.get("NAME") || "")]
                    .filter(Boolean)
                    .join("/"),
            ].filter((candidate) => candidate.length > 0);
            if (candidates.length > 0) {
                const candidate = candidates[0];
                return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
            }
        } catch {
            // fall through to directory scan
        }
    }
    for (const dir of ["build", "bin", "out"]) {
        const full = path.join(root, dir);
        if (!fs.existsSync(full)) {
            continue;
        }
        try {
            const found = fs
                .readdirSync(full)
                .filter((name) => !name.endsWith(".o") && !name.endsWith(".d") && !name.endsWith(".a"))
                .filter((name) => !name.endsWith("-stripped"))
                .map((name) => path.join(full, name))
                .filter((file) => {
                    try {
                        const stat = fs.statSync(file);
                        return stat.isFile() && (stat.mode & 0o111) !== 0;
                    } catch {
                        return false;
                    }
                })
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            if (found.length > 0) {
                return found[0];
            }
        } catch {
            // ignore unreadable directories
        }
    }
    const configured = vscode.workspace
        .getConfiguration("nasmIde", folder.uri)
        .get<string>("build.output", "bin/${workspaceFolderBasename}");
    const expanded = substVars(configured, folder);
    return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

function parseMakeVariables(text: string): Map<string, string> {
    const vars = new Map<string, string>();
    const re = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=|\?=)\s*(.*?)\s*(?:#.*)?$/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const key = match[1];
        const value = match[2].trim();
        if (key && !vars.has(key)) {
            vars.set(key, value);
        }
    }
    return vars;
}
