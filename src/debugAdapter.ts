// NASM debug adapter: gdb/MI <-> Debug Adapter Protocol.
//
// Launch modes:
//   integratedTerminal / externalTerminal : gdbserver runs the program in a
//       real terminal (ncurses and X11 work), the adapter controls gdb over
//       a TCP remote connection.
//   internalConsole : gdb runs the program directly; stdin/stdout are pipes.
// Attach mode connects to a running PID or a gdbserver host:port.
import {
    Breakpoint,
    ContinuedEvent,
    DebugSession,
    ExitedEvent,
    Handles,
    InitializedEvent,
    InvalidatedEvent,
    MemoryEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
    Variable,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import {
    GdbMi,
    MiRecord,
    MiTuple,
    MiValue,
    miNumber,
    miQuote,
    miString,
} from "./gdb";
import { DataSymbol, loadDataSymbols } from "./dataSymbols";

const THREAD_ID = 1;

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    args?: string[];
    cwd?: string;
    env?: { [key: string]: string | null };
    console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
    stopOnEntry?: boolean;
    gdbPath?: string;
    miDebuggerPath?: string;
    gdbserverPath?: string;
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    program?: string;
    processId?: number;
    host?: string;
    port?: number;
    cwd?: string;
    gdbPath?: string;
    miDebuggerPath?: string;
    stopOnEntry?: boolean;
}

interface BreakpointSpec {
    line: number;
    condition?: string;
    hitCondition?: string;
    gdbId?: number;
}

interface FunctionBpSpec {
    name: string;
    condition?: string;
    hitCondition?: string;
    gdbId?: number;
}

interface InstructionBpSpec {
    address: string;
    condition?: string;
    gdbId?: number;
}

type ScopeRef =
    | { kind: "registers" }
    | { kind: "flags" }
    | { kind: "stack" }
    | { kind: "data" }
    | { kind: "dataGroup"; symbol: DataSymbol; children: DataSymbol[] }
    | { kind: "dataBytes"; address: number; size: number };

const DATA_ELEMENT_SIZES: Record<string, number> = {
    db: 1,
    dw: 2,
    dd: 4,
    dq: 8,
    dt: 10,
    do: 16,
    dy: 32,
    dz: 64,
    resb: 1,
    resw: 2,
    resd: 4,
    resq: 8,
    rest: 10,
    reso: 16,
    resy: 32,
    resz: 64,
};

const REGISTER_ORDER = [
    "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp",
    "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
    "rip", "eflags", "rflags", "cs", "ss", "ds", "es", "fs", "gs",
];

const FLAG_BITS: Array<[string, number, number]> = [
    ["CF", 0, 1],
    ["PF", 2, 1],
    ["AF", 4, 1],
    ["ZF", 6, 1],
    ["SF", 7, 1],
    ["TF", 8, 1],
    ["IF", 9, 1],
    ["DF", 10, 1],
    ["OF", 11, 1],
    ["IOPL", 12, 2],
    ["NT", 14, 1],
    ["RF", 16, 1],
    ["VM", 17, 1],
    ["AC", 18, 1],
    ["VIF", 19, 1],
    ["VIP", 20, 1],
    ["ID", 21, 1],
];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function asArray(value: MiValue | undefined): MiValue[] {
    return Array.isArray(value) ? value : [];
}

function asTuple(value: MiValue | undefined): MiTuple {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as MiTuple)
        : {};
}

function displayValue(value: MiValue | undefined): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return `[${value.map(displayValue).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .map(([k, v]) => `${k}=${displayValue(v)}`)
            .join(",")}}`;
    }
    return "";
}

function parseIntValue(text: string): number {
    const t = text.trim();
    const hexMatch = /^0x[0-9a-f]+/i.exec(t);
    if (hexMatch) {
        return parseInt(hexMatch[0], 16);
    }
    const decMatch = /^-?\d+/.exec(t);
    if (decMatch) {
        return parseInt(decMatch[0], 10);
    }
    return NaN;
}

function hex(n: number): string {
    return `0x${Math.trunc(n).toString(16)}`;
}

function parseRegisterValue(text: string): bigint | undefined {
    const t = text.trim();
    if (/^0x[0-9a-f]+$/i.test(t)) {
        return BigInt(t);
    }
    const parsed = parseIntValue(t);
    return isNaN(parsed) ? undefined : BigInt(Math.trunc(parsed));
}

function normalizeRegisterHex(text: string): string {
    const value = parseRegisterValue(text);
    return value === undefined ? text : `0x${value.toString(16)}`;
}

function registerAscii(value: bigint): string | undefined {
    if (value <= 0n) {
        return undefined;
    }
    const bytes: number[] = [];
    let remaining = value;
    while (remaining > 0n) {
        bytes.push(Number(remaining & 0xffn));
        remaining >>= 8n;
    }
    while (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
        bytes.pop();
    }
    if (bytes.length === 0 || !bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        return undefined;
    }
    const text = bytes.map((byte) => String.fromCharCode(byte)).join("");
    const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
    return text.length === 1 ? `'${escaped}'` : `"${escaped}"`;
}

function formatRegisterValue(name: string, raw: string): string {
    const lower = name.toLowerCase();
    if (["rflags", "eflags", "cs", "ss", "ds", "es", "fs", "gs"].includes(lower)) {
        return raw;
    }
    const value = parseRegisterValue(raw);
    if (value === undefined) {
        return raw;
    }
    const parts = [raw, `(${value.toString(10)})`];
    if (!["rip", "eip", "rsp", "esp", "rbp", "ebp"].includes(lower)) {
        const ascii = registerAscii(value);
        if (ascii) {
            parts.push(ascii);
        }
    }
    if (lower === "rsp" || lower === "esp") {
        const mod = Number(value % 16n);
        parts.push(`[${lower} % 16 = ${mod}${mod === 0 ? ", aligned" : ""}]`);
    }
    return parts.join("  ");
}

/** VS Code edits the displayed value, so strip our read-only annotations. */
function registerEditValue(text: string): string {
    const trimmed = text.trim();
    const match =
        /^(0x[0-9a-f]+)\s{2,}\([^)]*\)(?:\s{2,}(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\[(?:r|e)sp % 16 = \d+(?:, aligned)?\]))?$/i.exec(
            trimmed
        );
    return match ? match[1] : trimmed;
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
        });
    });
}

class NasmDebugSession extends DebugSession {
    private gdb: GdbMi | null = null;
    private launchArgs: LaunchRequestArguments | null = null;
    private attachArgs: AttachRequestArguments | null = null;
    private mode: "launch" | "attach" = "launch";
    private cwd = process.cwd();
    private program = "";
    private handles = new Handles<ScopeRef>();
    private frameLevel = 0;
    private threadId = THREAD_ID;
    private configured = false;
    private stopOnEntry = false;
    private pendingStop: MiRecord | null = null;
    private entryPending = false;
    private terminating = false;
    private gdbserverPort: number | null = null;
    private registerNames: string[] | null = null;
    private dataSymbols: DataSymbol[] | null = null;
    private runInConsole = false;
    private sourceBreakpoints = new Map<string, BreakpointSpec[]>();
    private functionBreakpoints: FunctionBpSpec[] = [];
    private instructionBreakpoints: InstructionBpSpec[] = [];
    private sourceFiles: Set<string> | null = null;
    private warnedMissingLineInfo = new Set<string>();

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments
    ): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsSetVariable = true;
        response.body.supportsRestartRequest = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportsInstructionBreakpoints = true;
        response.body.supportsDisassembleRequest = true;
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = true;
        response.body.supportsSteppingGranularity = true;
        // These fields are understood by current VS Code but are missing from
        // the older @vscode/debugprotocol typings used by this extension.
        (response.body as DebugProtocol.Capabilities & {
            supportsInvalidatedEvent?: boolean;
            supportsMemoryEvent?: boolean;
        }).supportsInvalidatedEvent = true;
        (response.body as DebugProtocol.Capabilities & {
            supportsInvalidatedEvent?: boolean;
            supportsMemoryEvent?: boolean;
        }).supportsMemoryEvent = true;
        response.body.supportTerminateDebuggee = true;
        response.body.exceptionBreakpointFilters = [
            { filter: "SIGSEGV", label: "Segmentation fault", default: false },
            { filter: "SIGABRT", label: "Abort", default: false },
            { filter: "SIGILL", label: "Illegal instruction", default: false },
            { filter: "SIGFPE", label: "Floating point exception", default: false },
        ];
        this.sendResponse(response);
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchRequestArguments
    ): Promise<void> {
        try {
            this.mode = "launch";
            await this.startLaunch(args);
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        } catch (err) {
            this.sendErrorResponse(response, 2001, errorMessage(err));
            this.cleanup();
        }
    }

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: AttachRequestArguments
    ): Promise<void> {
        try {
            this.mode = "attach";
            await this.startAttach(args);
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        } catch (err) {
            this.sendErrorResponse(response, 2002, errorMessage(err));
            this.cleanup();
        }
    }

    private async startLaunch(args: LaunchRequestArguments): Promise<void> {
        this.launchArgs = args;
        this.attachArgs = null;
        this.terminating = false;
        this.configured = false;
        this.pendingStop = null;
        this.entryPending = false;
        this.cwd = path.resolve(args.cwd || process.cwd());
        this.program = path.isAbsolute(args.program)
            ? args.program
            : path.resolve(this.cwd, args.program);
        this.dataSymbols = null;
        this.sourceFiles = null;
        this.warnedMissingLineInfo.clear();
        if (!fs.existsSync(this.program)) {
            throw new Error(`program not found: ${this.program} (build it first)`);
        }
        this.stopOnEntry = !!args.stopOnEntry;

        const gdbPath = args.gdbPath || args.miDebuggerPath || "gdb";
        this.gdb = new GdbMi(gdbPath, this.cwd);
        this.wireGdb();

        await this.setupGdb();
        await this.gdb.send(`-file-exec-and-symbols ${miQuote(this.program)}`);
        await this.gdb.send(`-environment-cd ${miQuote(this.cwd)}`);
        await this.applyEnvironment(args.env);
        if (args.args && args.args.length > 0) {
            await this.gdb.send(`-exec-arguments ${args.args.map(miQuote).join(" ")}`);
        }

        const consoleMode = args.console || "integratedTerminal";
        this.runInConsole = consoleMode === "internalConsole";
        if (this.runInConsole) {
            // Started in configurationDone (so breakpoints exist first).
            return;
        }

        try {
            await this.startGdbserver(args);
            await this.connectRemote("127.0.0.1", this.gdbserverPort as number);
        } catch (err) {
            // runInTerminal can be unavailable (e.g. a client without the
            // reverse request); fall back to a direct run and say so.
            this.sendEvent(
                new OutputEvent(
                    `NASM IDE: terminal launch failed (${errorMessage(err)}); falling back to the Debug Console.\n`,
                    "console"
                )
            );
            this.sendEvent(new OutputEvent("NASM IDE: next time set \"console\": \"internalConsole\".\n", "console"));
            this.runInConsole = true;
        }
    }

    private async startAttach(args: AttachRequestArguments): Promise<void> {
        this.attachArgs = args;
        this.launchArgs = null;
        this.terminating = false;
        this.configured = false;
        this.pendingStop = null;
        this.entryPending = false;
        this.cwd = path.resolve(args.cwd || process.cwd());
        this.program = args.program
            ? path.isAbsolute(args.program)
                ? args.program
                : path.resolve(this.cwd, args.program)
            : "";
        this.dataSymbols = null;
        this.sourceFiles = null;
        this.warnedMissingLineInfo.clear();
        this.stopOnEntry = !!args.stopOnEntry;

        const gdbPath = args.gdbPath || args.miDebuggerPath || "gdb";
        this.gdb = new GdbMi(gdbPath, this.cwd);
        this.wireGdb();

        await this.setupGdb();
        await this.gdb.send(`-environment-cd ${miQuote(this.cwd)}`);
        if (this.program) {
            await this.gdb.send(`-file-exec-and-symbols ${miQuote(this.program)}`);
        }

        if (typeof args.processId === "number" && args.processId > 0) {
            await this.gdb.send(`-target-attach ${args.processId}`);
        } else if (typeof args.port === "number" && args.port > 0) {
            await this.connectRemote(args.host || "127.0.0.1", args.port);
        } else {
            throw new Error("attach requires processId or host/port");
        }
    }

    private async setupGdb(): Promise<void> {
        const gdb = this.gdb as GdbMi;
        await gdb.trySend("-gdb-set mi-async on");
        await gdb.trySend("-gdb-set pagination off");
        await gdb.trySend("-gdb-set confirm off");
        await gdb.trySend("-gdb-set width 0");
        await gdb.trySend("-gdb-set height 0");
        await gdb.trySend("-gdb-set breakpoint pending on");
        await gdb.trySend("-gdb-set print elements 256");
        await gdb.trySend("-gdb-set disassembly-flavor intel");
    }

    private wireGdb(): void {
        const gdb = this.gdb as GdbMi;
        gdb.on("stop", (rec: MiRecord) => this.onStop(rec));
        gdb.on("running", () => {
            if (this.configured && !this.terminating) {
                this.sendEvent(new ContinuedEvent(this.threadId, true));
            }
        });
        gdb.on("target", (text: string) => {
            if (text) {
                this.sendEvent(new OutputEvent(text, "stdout"));
            }
        });
        gdb.on("log", (text: string) => {
            if (text.trim()) {
                this.sendEvent(new OutputEvent(text, "console"));
            }
        });
        gdb.on("exit", (code: number | null) => {
            if (!this.terminating) {
                this.terminating = true;
                this.sendEvent(new ExitedEvent(typeof code === "number" ? code : 0));
                this.sendEvent(new TerminatedEvent());
            }
        });
    }

    private async applyEnvironment(env: LaunchRequestArguments["env"]): Promise<void> {
        if (!env) {
            return;
        }
        for (const [key, value] of Object.entries(env)) {
            if (value === null) {
                await this.gdb?.trySend(`-interpreter-exec console ${miQuote(`unset environment ${key}`)}`);
            } else {
                await this.gdb?.trySend(
                    `-interpreter-exec console ${miQuote(`set environment ${key} ${value}`)}`
                );
            }
        }
    }

    private async startGdbserver(args: LaunchRequestArguments): Promise<void> {
        const port = await getFreePort();
        this.gdbserverPort = port;
        const server = args.gdbserverPath || "gdbserver";
        const argv = [
            server,
            "--once",
            "--no-startup-with-shell",
            `127.0.0.1:${port}`,
            this.program,
            ...(args.args || []),
        ];
        const kind = args.console === "externalTerminal" ? "external" : "integrated";
        await new Promise<void>((resolve, reject) => {
            this.runInTerminalRequest(
                {
                    kind,
                    title: "NASM Debug",
                    cwd: this.cwd,
                    args: argv,
                    env: args.env as { [key: string]: string | null } | undefined,
                    argsCanBeInterpretedByShell: false,
                },
                10000,
                (res) => {
                    if (res && res.success) {
                        resolve();
                    } else {
                        reject(new Error(res?.message || "runInTerminal was rejected"));
                    }
                }
            );
        });
    }

    private async connectRemote(host: string, port: number): Promise<void> {
        const gdb = this.gdb as GdbMi;
        let lastError = "";
        for (let attempt = 0; attempt < 120; attempt++) {
            try {
                await gdb.send(`-target-select remote ${host}:${port}`, 4000);
                return;
            } catch (err) {
                lastError = errorMessage(err);
                await sleep(100);
            }
        }
        throw new Error(`could not connect to gdbserver at ${host}:${port}: ${lastError}`);
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        _args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        this.sendResponse(response);
        this.configured = true;
        const run = async (): Promise<void> => {
            const gdb = this.gdb;
            if (!gdb) {
                return;
            }
            if (this.pendingStop) {
                const rec = this.pendingStop;
                this.pendingStop = null;
                if (this.stopOnEntry) {
                    this.reportStop(rec, "entry");
                } else {
                    await gdb.send("-exec-continue");
                }
                return;
            }
            if (this.mode === "launch" && this.runInConsole) {
                if (this.stopOnEntry) {
                    this.entryPending = true;
                    await gdb.send(`-interpreter-exec console ${miQuote("starti")}`);
                } else {
                    await gdb.send("-exec-run");
                }
            } else if (this.stopOnEntry) {
                this.sendEvent(new StoppedEvent("entry", this.threadId));
            }
        };
        run().catch((err) => {
            this.entryPending = false;
            this.sendEvent(new OutputEvent(`NASM IDE: ${errorMessage(err)}\n`, "stderr"));
        });
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const sourcePath = this.sourcePath(args.source.path || "");
        const existing = this.sourceBreakpoints.get(sourcePath) || [];
        await this.deleteBreakpoints(existing.map((b) => b.gdbId));
        const specs: BreakpointSpec[] = [];
        const result: DebugProtocol.Breakpoint[] = [];
        for (const requested of args.breakpoints || []) {
            const spec: BreakpointSpec = {
                line: requested.line,
                condition: requested.condition,
                hitCondition: requested.hitCondition,
            };
            specs.push(spec);
            result.push(await this.insertSourceBreakpoint(sourcePath, spec));
        }
        this.sourceBreakpoints.set(sourcePath, specs);
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    private async insertSourceBreakpoint(sourcePath: string, spec: BreakpointSpec): Promise<Breakpoint> {
        const bp = new Breakpoint(false, spec.line) as Breakpoint & DebugProtocol.Breakpoint;
        try {
            const gdb = this.gdb as GdbMi;
            const rec = await gdb.send(
                `-break-insert -f ${miQuote(`${sourcePath}:${spec.line}`)}`
            );
            const bkpt = asTuple(rec.results.bkpt);
            const number = miNumber(bkpt.number);
            if (!isNaN(number)) {
                spec.gdbId = number;
                bp.setId(number);
            }
            const pending = miString(bkpt.pending);
            const addr = miString(bkpt.addr);
            const isPending = !!pending || !addr || addr === "<PENDING>";
            bp.verified = !isPending;
            const actualLine = miNumber(bkpt.line);
            if (!isNaN(actualLine) && actualLine > 0) {
                bp.line = actualLine;
            }
            if (!bp.verified) {
                const hasLineInfo = await this.sourceHasLineInfo(sourcePath);
                if (!fs.existsSync(sourcePath)) {
                    bp.message = `source file not found: ${sourcePath}`;
                } else if (hasLineInfo === false) {
                    bp.message =
                        "no debug line info for this file; if it contains code, put it in `section .text` and rebuild with -g -F dwarf";
                    this.warnMissingLineInfo(sourcePath);
                } else {
                    bp.message = "pending until the code is loaded";
                }
            }
            if (spec.condition && !isNaN(number)) {
                await gdb.send(`-break-condition ${number} ${miQuote(spec.condition)}`);
            }
            if (spec.hitCondition && !isNaN(number) && /^\d+$/.test(spec.hitCondition)) {
                await gdb.send(`-break-after ${number} ${parseInt(spec.hitCondition, 10)}`);
            }
        } catch (err) {
            bp.verified = false;
            bp.message = errorMessage(err);
        }
        return bp;
    }

    /**
     * GDB's source-file list only contains files with debug line information.
     * A NASM file whose code is still in `.rodata`/`.data` is absent here, which
     * is the usual reason a source breakpoint stays pending forever.
     */
    private async sourceHasLineInfo(sourcePath: string): Promise<boolean | undefined> {
        try {
            if (!this.sourceFiles) {
                const rec = await (this.gdb as GdbMi).send("-file-list-exec-source-files");
                const files = new Set<string>();
                for (const entry of asArray(rec.results.files)) {
                    const tuple = asTuple(entry);
                    const name = miString(tuple.fullname) || miString(tuple.file);
                    if (name) {
                        files.add(path.resolve(this.cwd, name));
                    }
                }
                this.sourceFiles = files;
            }
            return this.sourceFiles.has(path.resolve(sourcePath));
        } catch {
            return undefined;
        }
    }

    private warnMissingLineInfo(sourcePath: string): void {
        if (this.warnedMissingLineInfo.has(sourcePath)) {
            return;
        }
        this.warnedMissingLineInfo.add(sourcePath);
        this.sendEvent(
            new OutputEvent(
                `NASM IDE: ${sourcePath} has no debug line information. ` +
                    "If this file contains code, add `section .text` before it and rebuild " +
                    "with -g -F dwarf. NASM only emits line tables for executable sections.\n",
                "console"
            )
        );
    }

    protected async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments
    ): Promise<void> {
        await this.deleteBreakpoints(this.functionBreakpoints.map((b) => b.gdbId));
        const specs: FunctionBpSpec[] = [];
        const result: DebugProtocol.Breakpoint[] = [];
        for (const requested of args.breakpoints || []) {
            const spec: FunctionBpSpec = {
                name: requested.name,
                condition: requested.condition,
                hitCondition: requested.hitCondition,
            };
            specs.push(spec);
            const bp = new Breakpoint(false) as Breakpoint & DebugProtocol.Breakpoint;
            try {
                const rec = await (this.gdb as GdbMi).send(`-break-insert -f ${miQuote(spec.name)}`);
                const bkpt = asTuple(rec.results.bkpt);
                const number = miNumber(bkpt.number);
                if (!isNaN(number)) {
                    spec.gdbId = number;
                    bp.setId(number);
                }
                const pending = miString(bkpt.pending);
                const addr = miString(bkpt.addr);
                bp.verified = !!addr && addr !== "<PENDING>" && !pending;
                const line = miNumber(bkpt.line);
                if (!isNaN(line) && line > 0) {
                    bp.line = line;
                }
                if (spec.condition && !isNaN(number)) {
                    await (this.gdb as GdbMi).send(`-break-condition ${number} ${miQuote(spec.condition)}`);
                }
                if (spec.hitCondition && !isNaN(number) && /^\d+$/.test(spec.hitCondition)) {
                    await (this.gdb as GdbMi).send(`-break-after ${number} ${parseInt(spec.hitCondition, 10)}`);
                }
            } catch (err) {
                bp.verified = false;
                bp.message = errorMessage(err);
            }
            result.push(bp);
        }
        this.functionBreakpoints = specs;
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    protected async setInstructionBreakpointsRequest(
        response: DebugProtocol.SetInstructionBreakpointsResponse,
        args: DebugProtocol.SetInstructionBreakpointsArguments
    ): Promise<void> {
        await this.deleteBreakpoints(this.instructionBreakpoints.map((b) => b.gdbId));
        const specs: InstructionBpSpec[] = [];
        const result: DebugProtocol.Breakpoint[] = [];
        for (const requested of args.breakpoints || []) {
            const base = parseIntValue(requested.instructionReference);
            const address = isNaN(base) ? requested.instructionReference : hex(base + (requested.offset || 0));
            const spec: InstructionBpSpec = { address };
            specs.push(spec);
            const bp = new Breakpoint(false) as Breakpoint & DebugProtocol.Breakpoint;
            try {
                const rec = await (this.gdb as GdbMi).send(`-break-insert -f *${address}`);
                const bkpt = asTuple(rec.results.bkpt);
                const number = miNumber(bkpt.number);
                if (!isNaN(number)) {
                    spec.gdbId = number;
                    bp.setId(number);
                }
                const pending = miString(bkpt.pending);
                const addr = miString(bkpt.addr);
                bp.verified = !!addr && addr !== "<PENDING>" && !pending;
            } catch (err) {
                bp.verified = false;
                bp.message = errorMessage(err);
            }
            result.push(bp);
        }
        this.instructionBreakpoints = specs;
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    protected setExceptionBreakPointsRequest(
        response: DebugProtocol.SetExceptionBreakpointsResponse,
        _args: DebugProtocol.SetExceptionBreakpointsArguments
    ): void {
        response.body = { breakpoints: [] };
        this.sendResponse(response);
    }

    private async deleteBreakpoints(ids: Array<number | undefined>): Promise<void> {
        const nums = ids.filter((id): id is number => typeof id === "number" && !isNaN(id));
        if (nums.length === 0 || !this.gdb) {
            return;
        }
        try {
            await this.gdb.send(`-break-delete ${nums.join(" ")}`);
        } catch {
            // already gone
        }
    }

    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments
    ): void {
        this.continueCommand(response, "-exec-continue");
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        const instruction = args.granularity === "instruction";
        this.continueCommand(response, instruction ? "-exec-next-instruction" : "-exec-next");
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        const instruction = args.granularity === "instruction";
        this.continueCommand(response, instruction ? "-exec-step-instruction" : "-exec-step");
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
        this.continueCommand(response, "-exec-finish");
    }

    private continueCommand(response: DebugProtocol.Response, command: string): void {
        const gdb = this.gdb;
        if (!gdb) {
            this.sendErrorResponse(response, 2003, "no gdb session");
            return;
        }
        gdb.send(command)
            .then(() => this.sendResponse(response))
            .catch((err) => this.sendErrorResponse(response, 2004, errorMessage(err)));
    }

    protected async pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments
    ): Promise<void> {
        try {
            await (this.gdb as GdbMi).send("-exec-interrupt");
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2005, errorMessage(err));
        }
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            const rec = await (this.gdb as GdbMi).send("-thread-info");
            const threads = asArray(rec.results.threads).map((entry) => {
                const t = asTuple(entry);
                const id = miNumber(t.id);
                const name = miString(t.name) || miString(t["target-id"]) || `Thread ${id}`;
                return new Thread(isNaN(id) ? THREAD_ID : id, name);
            });
            response.body = { threads: threads.length > 0 ? threads : [new Thread(THREAD_ID, "main")] };
        } catch {
            response.body = { threads: [new Thread(THREAD_ID, "main")] };
        }
        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        this.threadId = args.threadId || THREAD_ID;
        try {
            const gdb = this.gdb as GdbMi;
            await gdb.trySend(`-thread-select ${this.threadId}`);
            const rec = await gdb.send("-stack-list-frames");
            const frames = asArray(rec.results.stack).map((entry) => {
                const f = asTuple(entry);
                const level = miNumber(f.level);
                const addr = miString(f.addr);
                const fn = miString(f.func) || (addr ? addr : "??");
                const src = this.makeSource(miString(f.file));
                const line = miNumber(f.line);
                const frame = new StackFrame(
                    isNaN(level) ? 0 : level + 1,
                    fn,
                    src,
                    !isNaN(line) && line > 0 ? line : undefined,
                    0
                );
                if (addr) {
                    frame.instructionPointerReference = addr;
                }
                return frame;
            });
            const start = args.startFrame || 0;
            const levels = args.levels && args.levels > 0 ? args.levels : frames.length;
            response.body = {
                stackFrames: frames.slice(start, start + levels),
                totalFrames: frames.length,
            };
        } catch (err) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendEvent(new OutputEvent(`NASM IDE: stack trace failed: ${errorMessage(err)}\n`, "stderr"));
        }
        this.sendResponse(response);
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        this.frameLevel = Math.max(0, (args.frameId || 1) - 1);
        try {
            await (this.gdb as GdbMi).trySend(`-stack-select-frame ${this.frameLevel}`);
        } catch {
            // frame may have gone away
        }
        this.handles.reset();
        response.body = {
            scopes: [
                new Scope("Registers", this.handles.create({ kind: "registers" }), false),
                new Scope("Flags", this.handles.create({ kind: "flags" }), false),
                new Scope("Data (.data/.bss)", this.handles.create({ kind: "data" }), false),
                new Scope("Stack (rsp)", this.handles.create({ kind: "stack" }), false),
            ],
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        const ref = this.handles.get(args.variablesReference);
        try {
            if (!ref) {
                response.body = { variables: [] };
            } else if (ref.kind === "registers") {
                response.body = { variables: await this.registerVariables() };
            } else if (ref.kind === "flags") {
                response.body = { variables: await this.flagVariables() };
            } else if (ref.kind === "data") {
                response.body = { variables: await this.dataVariables() };
            } else if (ref.kind === "dataGroup") {
                response.body = { variables: await this.dataGroupVariables(ref) };
            } else if (ref.kind === "dataBytes") {
                response.body = { variables: await this.dataByteVariables(ref) };
            } else {
                response.body = { variables: await this.stackVariables() };
            }
        } catch (err) {
            response.body = { variables: [] };
            this.sendEvent(new OutputEvent(`NASM IDE: ${errorMessage(err)}\n`, "stderr"));
        }
        this.sendResponse(response);
    }

    private async registerVariables(): Promise<Variable[]> {
        const gdb = this.gdb as GdbMi;
        if (!this.registerNames) {
            const namesRec = await gdb.send("-data-list-register-names");
            this.registerNames = asArray(namesRec.results["register-names"]).map((v) => miString(v));
        }
        const valuesRec = await gdb.send("-data-list-register-values x");
        const values = asArray(valuesRec.results["register-values"]).map((v) => asTuple(v));
        const order = (name: string): number => {
            const idx = REGISTER_ORDER.indexOf(name.toLowerCase());
            return idx < 0 ? REGISTER_ORDER.length + 1 : idx;
        };
        const entries: Array<{ name: string; value: string; order: number; seq: number }> = [];
        values.forEach((entry, seq) => {
            const num = miNumber(entry.number);
            const name = !isNaN(num) ? this.registerNames?.[num] || "" : "";
            if (!name) {
                return;
            }
            entries.push({
                name,
                value: displayValue(entry.value),
                order: order(name),
                seq,
            });
        });
        entries.sort((a, b) => a.order - b.order || a.seq - b.seq);
        return entries.map((entry) => {
            const raw = entry.value || "0x0";
            const variable = new Variable(entry.name, formatRegisterValue(entry.name, raw)) as DebugProtocol.Variable;
            variable.type = "register";
            if (/^0x[0-9a-f]+$/i.test(raw) && raw !== "0x0") {
                variable.memoryReference = raw;
            }
            return variable;
        });
    }

    private async flagVariables(): Promise<Variable[]> {
        const flags = await this.readFlagsRegister();
        if (isNaN(flags)) {
            return [];
        }
        const variables: Variable[] = [];
        const raw = new Variable("RFLAGS", hex(flags)) as DebugProtocol.Variable;
        raw.type = "flags";
        variables.push(raw);
        for (const [name, bit, width] of FLAG_BITS) {
            const mask = (1 << width) - 1;
            const bits = (flags >>> bit) & mask;
            const v = new Variable(name, String(bits)) as DebugProtocol.Variable;
            v.type = width === 1 ? "flag" : "field";
            variables.push(v);
        }
        return variables;
    }

    private async dataVariables(): Promise<Variable[]> {
        const symbols = await this.resolveDataSymbols();
        if (symbols.length === 0) {
            return [];
        }
        const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
        const parentOf = (name: string): string => {
            const dot = name.lastIndexOf(".");
            return dot > 0 ? name.slice(0, dot) : "";
        };
        const childrenOf = new Map<string, DataSymbol[]>();
        for (const symbol of symbols) {
            const parent = parentOf(symbol.name);
            if (!parent || !byName.has(parent)) {
                continue;
            }
            const children = childrenOf.get(parent) || [];
            children.push(symbol);
            childrenOf.set(parent, children);
        }
        const topLevel = symbols
            .filter((symbol) => {
                const parent = parentOf(symbol.name);
                return !parent || !byName.has(parent);
            })
            .sort((a, b) => (a.address ?? 0) - (b.address ?? 0) || a.name.localeCompare(b.name));
        const variables: Variable[] = [];
        for (const symbol of topLevel) {
            variables.push(await this.makeDataVariable(symbol, childrenOf.get(symbol.name) || []));
        }
        return variables;
    }

    private async dataGroupVariables(
        ref: { kind: "dataGroup"; symbol: DataSymbol; children: DataSymbol[] }
    ): Promise<Variable[]> {
        const variables: Variable[] = [];
        for (const child of ref.children) {
            variables.push(await this.makeDataVariable(child, []));
        }
        return variables;
    }

    private async dataByteVariables(
        ref: { kind: "dataBytes"; address: number; size: number }
    ): Promise<Variable[]> {
        if (ref.size <= 0) {
            return [];
        }
        const shownSize = Math.min(ref.size, 1024);
        const bytes = await this.readDataBytes(ref.address, shownSize);
        const variables: Variable[] = [];
        const perRow = 16;
        for (let offset = 0; offset < bytes.length; offset += perRow) {
            const row = bytes.subarray(offset, Math.min(offset + perRow, bytes.length));
            const hexText = Array.from(row, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
            const asciiText = Array.from(row, (byte) =>
                byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."
            ).join("");
            const variable = new Variable(
                `+0x${offset.toString(16).padStart(4, "0")}`,
                `${hexText.padEnd(perRow * 3 - 1)}  ${asciiText}`
            ) as DebugProtocol.Variable;
            variable.type = `${row.length} bytes`;
            variable.memoryReference = hex(ref.address + offset);
            variables.push(variable);
        }
        if (ref.size > shownSize) {
            const variable = new Variable("...", `(${ref.size - shownSize} more bytes)`);
            variables.push(variable);
        }
        return variables;
    }

    private async makeDataVariable(symbol: DataSymbol, children: DataSymbol[]): Promise<Variable> {
        const address = symbol.address ?? 0;
        const size = this.dataSize(symbol, children);
        const element = DATA_ELEMENT_SIZES[symbol.type] || 1;
        if (children.length > 0) {
            const variable = new Variable(
                symbol.displayName,
                `{${children.length} field${children.length === 1 ? "" : "s"}}`
            ) as DebugProtocol.Variable;
            variable.type = `struct @ ${hex(address)}`;
            variable.memoryReference = hex(address);
            variable.variablesReference = this.handles.create({
                kind: "dataGroup",
                symbol,
                children,
            });
            return variable;
        }
        const bytes = size > 0 ? await this.readDataBytes(address, Math.min(size, 4096)) : Buffer.alloc(0);
        const variable = new Variable(symbol.displayName, this.formatDataValue(symbol, bytes)) as DebugProtocol.Variable;
        const count = element > 0 ? Math.floor(size / element) : 0;
        variable.type = size > element || count > 1
            ? `${symbol.type}[${count}] @ ${hex(address)}`
            : `${symbol.type} @ ${hex(address)}`;
        variable.memoryReference = hex(address);
        if (size > element) {
            variable.variablesReference = this.handles.create({
                kind: "dataBytes",
                address,
                size,
            });
        }
        return variable;
    }

    private dataSize(symbol: DataSymbol, children: DataSymbol[]): number {
        let size = Math.max(0, symbol.size ?? 0);
        if (children.length > 0) {
            const base = symbol.address ?? 0;
            for (const child of children) {
                const end = (child.address ?? base) + Math.max(0, child.size ?? 0);
                size = Math.max(size, end - base);
            }
        }
        return size;
    }

    private formatDataValue(symbol: DataSymbol, bytes: Buffer): string {
        if (bytes.length === 0) {
            return "<unavailable>";
        }
        const element = DATA_ELEMENT_SIZES[symbol.type] || 1;
        if (this.looksLikeText(symbol, bytes)) {
            return this.quoteBytes(bytes);
        }
        if (bytes.length <= element) {
            return this.formatScalar(bytes, element);
        }
        if (element <= 8 && bytes.length <= element * 16) {
            const values: string[] = [];
            for (let offset = 0; offset + element <= bytes.length; offset += element) {
                values.push(this.formatScalar(bytes.subarray(offset, offset + element), element));
            }
            return `[${values.join(", ")}]`;
        }
        const shown = bytes.subarray(0, Math.min(bytes.length, 24));
        const hexText = Array.from(shown, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
        return `${hexText}${bytes.length > shown.length ? " ..." : ""} (${bytes.length} bytes)`;
    }

    private formatScalar(bytes: Buffer, element: number): string {
        const value = readBufferLittleEndian(bytes, element);
        let text = hex(value);
        if (element <= 4) {
            text += ` (${value})`;
        }
        if (element === 1 && value >= 0x20 && value <= 0x7e) {
            text += ` '${String.fromCharCode(value)}'`;
        }
        return text;
    }

    private looksLikeText(symbol: DataSymbol, bytes: Buffer): boolean {
        if (symbol.type !== "db" && !symbol.type.startsWith("res")) {
            return false;
        }
        let printable = 0;
        for (const byte of bytes) {
            if (byte === 0) {
                continue;
            }
            if (byte >= 0x20 && byte <= 0x7e) {
                printable++;
            } else if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x1b) {
                return false;
            }
        }
        // A .bss buffer that is still all zeroes is more useful as a size.
        return printable > 0 && (symbol.type === "db" || bytes.includes(0));
    }

    private quoteBytes(bytes: Buffer): string {
        let text = '"';
        const limit = Math.min(bytes.length, 160);
        for (let i = 0; i < limit; i++) {
            const byte = bytes[i];
            if (byte === 0) {
                text += "\\0";
            } else if (byte === 0x0a) {
                text += "\\n";
            } else if (byte === 0x0d) {
                text += "\\r";
            } else if (byte === 0x09) {
                text += "\\t";
            } else if (byte === 0x1b) {
                text += "\\x1b";
            } else if (byte === 0x22 || byte === 0x5c) {
                text += `\\${String.fromCharCode(byte)}`;
            } else if (byte >= 0x20 && byte <= 0x7e) {
                text += String.fromCharCode(byte);
            } else {
                text += `\\x${byte.toString(16).padStart(2, "0")}`;
            }
        }
        if (bytes.length > limit) {
            text += "...";
        }
        return `${text}"`;
    }

    private async resolveDataSymbols(): Promise<DataSymbol[]> {
        if (this.dataSymbols) {
            return this.dataSymbols;
        }
        const symbols = loadDataSymbols(this.cwd);
        if (symbols.length === 0) {
            this.dataSymbols = [];
            return symbols;
        }
        const addresses = await this.gdbVariableAddresses();
        const visible = symbols.filter((symbol) => addresses.has(symbol.name));
        for (const symbol of visible) {
            symbol.address = addresses.get(symbol.name);
        }
        visible.sort((a, b) => (a.address ?? 0) - (b.address ?? 0) || a.name.localeCompare(b.name));
        for (let i = 0; i < visible.length; i++) {
            const symbol = visible[i];
            if (symbol.size !== undefined && symbol.size > 0) {
                continue;
            }
            if (symbol.aggregate) {
                continue;
            }
            let next = i + 1;
            while (next < visible.length && visible[next].address === symbol.address) {
                next++;
            }
            if (next < visible.length) {
                symbol.size = Math.max(0, (visible[next].address ?? 0) - (symbol.address ?? 0));
            } else {
                const end = addresses.get(symbol.section === ".data" ? "_edata" : "_end");
                if (end !== undefined && symbol.address !== undefined && end > symbol.address) {
                    symbol.size = end - symbol.address;
                }
            }
        }
        // A bare label like `Window:` gets its extent from its local fields.
        for (const symbol of visible) {
            if (!symbol.aggregate) {
                continue;
            }
            const base = symbol.address ?? 0;
            let end = base;
            for (const child of visible) {
                if (child.name.startsWith(`${symbol.name}.`)) {
                    end = Math.max(end, (child.address ?? 0) + (child.size ?? 0));
                }
            }
            if (end > base) {
                symbol.size = end - base;
            }
        }
        this.dataSymbols = visible;
        return visible;
    }

    private async gdbVariableAddresses(): Promise<Map<string, number>> {
        const gdb = this.requireGdb();
        let output = "";
        const listener = (text: string): void => {
            output += text;
        };
        gdb.on("console", listener);
        try {
            await gdb.send(
                `-interpreter-exec console ${miQuote("info variables")}`,
                15000
            );
        } catch {
            return new Map();
        } finally {
            gdb.removeListener("console", listener);
        }
        const addresses = new Map<string, number>();
        for (const line of output.split(/\r?\n/)) {
            const match = /^\s*(0x[0-9a-f]+)\s+(.+?)\s*$/i.exec(line);
            if (match) {
                addresses.set(match[2], parseInt(match[1], 16));
            }
        }
        return addresses;
    }

    private async readDataBytes(address: number, size: number): Promise<Buffer> {
        if (size <= 0) {
            return Buffer.alloc(0);
        }
        try {
            const rec = await (this.gdb as GdbMi).send(
                `-data-read-memory-bytes ${hex(address)} ${Math.min(size, 65536)}`
            );
            const blocks = asArray(rec.results.memory).map((entry) => asTuple(entry));
            const contents = blocks.map((block) => miString(block.contents)).join("");
            return Buffer.from(contents, "hex").subarray(0, size);
        } catch {
            return Buffer.alloc(0);
        }
    }

    private async stackVariables(): Promise<Variable[]> {
        const rsp = await this.evalInteger("$rsp");
        if (isNaN(rsp)) {
            return [];
        }
        const count = 16;
        const bytes = count * 8;
        const rec = await (this.gdb as GdbMi).send(`-data-read-memory-bytes ${hex(rsp)} ${bytes}`);
        const blocks = asArray(rec.results.memory).map((entry) => asTuple(entry));
        let contents = blocks.map((b) => miString(b.contents)).join("");
        const variables: Variable[] = [];
        const base = new Variable("rsp", hex(rsp)) as DebugProtocol.Variable;
        base.type = "register";
        base.memoryReference = hex(rsp);
        variables.push(base);
        for (let i = 0; i < count && contents.length >= (i + 1) * 16; i++) {
            const wordHex = contents.slice(i * 16, (i + 1) * 16);
            const value = readLittleEndian(wordHex);
            const address = rsp + i * 8;
            const v = new Variable(`[rsp+0x${(i * 8).toString(16).padStart(2, "0")}]`, hex(value)) as DebugProtocol.Variable;
            v.type = "qword";
            v.memoryReference = hex(address);
            variables.push(v);
        }
        return variables;
    }

    private async readFlagsRegister(): Promise<number> {
        const gdb = this.gdb as GdbMi;
        if (!this.registerNames) {
            const namesRec = await gdb.send("-data-list-register-names");
            this.registerNames = asArray(namesRec.results["register-names"]).map((v) => miString(v));
        }
        const names = this.registerNames || [];
        let index = names.indexOf("rflags");
        if (index < 0) {
            index = names.indexOf("eflags");
        }
        if (index >= 0) {
            const valuesRec = await gdb.send("-data-list-register-values x");
            const values = asArray(valuesRec.results["register-values"]).map((v) => asTuple(v));
            for (const entry of values) {
                if (miNumber(entry.number) === index) {
                    const parsed = parseIntValue(miString(entry.value));
                    if (!isNaN(parsed)) {
                        return parsed;
                    }
                }
            }
        }
        return this.evalInteger("$eflags & 0xffff");
    }

    private async evalInteger(expression: string): Promise<number> {
        try {
            const rec = await (this.gdb as GdbMi).send(
                `-data-evaluate-expression ${miQuote(expression)}`
            );
            return parseIntValue(miString(rec.results.value));
        } catch {
            return NaN;
        }
    }

    protected async setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments
    ): Promise<void> {
        const scope = this.handles.get(args.variablesReference);
        if (!scope) {
            this.sendErrorResponse(response, 2006, "unknown variable container");
            return;
        }
        try {
            if (scope.kind === "registers") {
                const gdb = this.gdb as GdbMi;
                const value = registerEditValue(args.value);
                await gdb.send(
                    `-interpreter-exec console ${miQuote(`set $${args.name} = ${value}`)}`
                );
                const rec = await gdb.send(
                    `-data-evaluate-expression ${miQuote(`$${args.name}`)}`
                );
                const raw = miString(rec.results.value);
                response.body = {
                    value: formatRegisterValue(args.name, normalizeRegisterHex(raw)),
                    type: "register",
                    variablesReference: 0,
                };
            } else if (scope.kind === "data") {
                const symbol = await this.findTopLevelDataSymbol(args.name);
                if (!symbol) {
                    throw new Error(`unknown data variable: ${args.name}`);
                }
                response.body = await this.writeDataSymbol(symbol, args.value);
            } else if (scope.kind === "dataGroup") {
                const symbol = scope.children.find(
                    (child) => child.displayName === args.name || child.name === args.name
                );
                if (!symbol) {
                    throw new Error(`unknown data field: ${args.name}`);
                }
                response.body = await this.writeDataSymbol(symbol, args.value);
            } else if (scope.kind === "dataBytes") {
                response.body = await this.writeDataBytes(scope, args.name, args.value);
            } else {
                throw new Error("this scope is read-only");
            }
            this.sendEvent(new InvalidatedEvent(["variables"], this.threadId));
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2007, errorMessage(err));
        }
    }

    private async findTopLevelDataSymbol(name: string): Promise<DataSymbol | undefined> {
        const symbols = await this.resolveDataSymbols();
        const names = new Set(symbols.map((symbol) => symbol.name));
        const parentOf = (value: string): string => {
            const dot = value.lastIndexOf(".");
            return dot > 0 ? value.slice(0, dot) : "";
        };
        return symbols.find((symbol) => {
            const parent = parentOf(symbol.name);
            const topLevel = !parent || !names.has(parent);
            return topLevel && (symbol.displayName === name || symbol.name === name);
        });
    }

    private async writeDataSymbol(
        symbol: DataSymbol,
        value: string
    ): Promise<DebugProtocol.SetVariableResponse["body"]> {
        const address = symbol.address;
        if (address === undefined) {
            throw new Error(`${symbol.name} has no address`);
        }
        if (symbol.aggregate) {
            throw new Error("expand this group and edit one of its fields");
        }
        const size = this.dataSize(symbol, []);
        if (size <= 0) {
            throw new Error(`${symbol.name} has no writable storage`);
        }
        const element = DATA_ELEMENT_SIZES[symbol.type] || 1;
        const bytes = this.parseDataValue(value, size, element, symbol.type);
        await (this.gdb as GdbMi).send(
            `-data-write-memory-bytes ${hex(address)} ${bytes.toString("hex")}`
        );
        this.sendEvent(new MemoryEvent(hex(address), 0, bytes.length));
        const updated = await this.readDataBytes(address, Math.min(size, 4096));
        const count = element > 0 ? Math.floor(size / element) : 0;
        return {
            value: this.formatDataValue(symbol, updated),
            type: size > element || count > 1
                ? `${symbol.type}[${count}] @ ${hex(address)}`
                : `${symbol.type} @ ${hex(address)}`,
            variablesReference: size > element
                ? this.handles.create({ kind: "dataBytes", address, size })
                : 0,
        };
    }

    private async writeDataBytes(
        ref: { kind: "dataBytes"; address: number; size: number },
        name: string,
        value: string
    ): Promise<DebugProtocol.SetVariableResponse["body"]> {
        const match = /^\+0x([0-9a-f]+)$/i.exec(name);
        if (!match) {
            throw new Error(`unknown data row: ${name}`);
        }
        const offset = parseInt(match[1], 16);
        const rowSize = Math.min(16, Math.max(0, ref.size - offset));
        if (rowSize <= 0) {
            throw new Error(`data row is out of range: ${name}`);
        }
        const bytes = this.parseDataValue(value, rowSize, 1, "db");
        const address = ref.address + offset;
        await (this.gdb as GdbMi).send(
            `-data-write-memory-bytes ${hex(address)} ${bytes.toString("hex")}`
        );
        this.sendEvent(new MemoryEvent(hex(address), 0, bytes.length));
        const updated = await this.readDataBytes(address, bytes.length);
        const hexText = Array.from(updated, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
        const asciiText = Array.from(updated, (byte) =>
            byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."
        ).join("");
        return {
            value: `${hexText.padEnd(47)}  ${asciiText}`,
            type: `${updated.length} bytes`,
            variablesReference: 0,
        };
    }

    /** Convert a user-entered value into bytes to write into a data variable. */
    private parseDataValue(value: string, size: number, element: number, type: string): Buffer {
        const text = value.trim();
        if (!text) {
            throw new Error("empty value");
        }
        const byteArray = type === "db" || type.startsWith("resb");
        if (
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'")) ||
            (text.startsWith("`") && text.endsWith("`"))
        ) {
            if (!byteArray) {
                throw new Error("quoted strings can only be written to byte data");
            }
            const bytes = decodeUserString(text);
            if (bytes.length > size) {
                throw new Error(`string is ${bytes.length} bytes, but ${size} bytes are available`);
            }
            // Editing a fixed-size buffer replaces the whole buffer.
            return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
        }
        // A whitespace/comma separated byte list, e.g. `68 69 00`, or a single
        // hex string such as `686900` / `0x686900`.
        if (byteArray) {
            const tokens = text.split(/[\s,]+/).filter(Boolean);
            const singleHex = /^0x([0-9a-f]+)$/i.exec(text) || /^([0-9a-f]+)$/i.exec(text);
            if (tokens.length > 1 || (singleHex && singleHex[1].length > 2)) {
                const parts = tokens.length > 1
                    ? tokens.map((token) => token.replace(/^0x/i, ""))
                    : [singleHex ? singleHex[1] : text];
                const bytes: number[] = [];
                for (const part of parts) {
                    if (part.length > 2) {
                        if (part.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(part)) {
                            throw new Error(`invalid hex bytes: ${text}`);
                        }
                        for (let i = 0; i < part.length; i += 2) {
                            bytes.push(parseInt(part.slice(i, i + 2), 16));
                        }
                    } else {
                        if (!/^[0-9a-f]{1,2}$/i.test(part)) {
                            throw new Error(`invalid byte: ${part}`);
                        }
                        bytes.push(parseInt(part, 16));
                    }
                }
                if (bytes.length > size) {
                    throw new Error(`${bytes.length} bytes do not fit in ${size} bytes`);
                }
                return Buffer.from(bytes);
            }
        }
        if (element > 1 && text.includes(",")) {
            const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
            const bytes: Buffer[] = [];
            for (const part of parts) {
                const number = parseUserNumber(part);
                if (number === undefined) {
                    throw new Error(`invalid value: ${part}`);
                }
                bytes.push(encodeLittleEndian(number, element));
            }
            return Buffer.concat(bytes);
        }
        const number = parseUserNumber(text);
        if (number === undefined) {
            throw new Error(`invalid value: ${text}`);
        }
        return encodeLittleEndian(number, element);
    }

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        if (!this.gdb) {
            this.sendErrorResponse(response, 2008, "no gdb session");
            return;
        }
        try {
            const rec = await this.gdb.send(
                `-data-evaluate-expression ${miQuote(args.expression)}`
            );
            response.body = {
                result: miString(rec.results.value),
                variablesReference: 0,
            };
            this.sendResponse(response);
            return;
        } catch (err) {
            if (args.context !== "repl") {
                this.sendErrorResponse(response, 2009, errorMessage(err));
                return;
            }
        }
        // Debug Console: let gdb commands through (`x/16gx $rsp`, `info reg`).
        let output = "";
        const listener = (text: string): void => {
            output += text;
        };
        this.gdb.on("console", listener);
        try {
            await this.gdb.send(`-interpreter-exec console ${miQuote(args.expression)}`);
            await sleep(30);
            response.body = { result: output.trim() || "ok", variablesReference: 0 };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2010, errorMessage(err));
        } finally {
            this.gdb.off("console", listener);
        }
    }

    protected async disassembleRequest(
        response: DebugProtocol.DisassembleResponse,
        args: DebugProtocol.DisassembleArguments
    ): Promise<void> {
        try {
            const gdb = this.gdb as GdbMi;
            const count = Math.max(1, args.instructionCount || 20);
            let base = parseIntValue(args.memoryReference);
            if (isNaN(base)) {
                base = await this.evalInteger("$pc");
            }
            if (isNaN(base)) {
                throw new Error("no disassembly address");
            }
            base += args.offset || 0;
            const instrOffset = args.instructionOffset || 0;
            const span = (count + Math.abs(instrOffset) + 4) * 15;
            const start = instrOffset < 0 ? base + instrOffset * 15 : base;
            const end = start + span;
            const rec = await gdb.send(
                `-data-disassemble -s ${hex(start)} -e ${hex(end)} -- 0`
            );
            let entries = asArray(rec.results.asm_insns).map((entry) => asTuple(entry));
            if (instrOffset > 0) {
                entries = entries.slice(instrOffset);
            }
            const instructions: DebugProtocol.DisassembledInstruction[] = entries.slice(0, count).map((entry) => {
                const address = miString(entry.address);
                const inst = miString(entry.inst);
                const func = miString(entry["func-name"]);
                const file = miString(entry.file);
                const line = miNumber(entry.line);
                const out: DebugProtocol.DisassembledInstruction = {
                    address,
                    instruction: inst,
                };
                if (func) {
                    out.symbol = func;
                }
                if (file) {
                    const src = this.makeSource(file);
                    if (src) {
                        out.location = src;
                    }
                    if (!isNaN(line) && line > 0) {
                        out.line = line;
                        out.column = 0;
                    }
                }
                return out;
            });
            response.body = { instructions };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2011, errorMessage(err));
        }
    }

    protected async readMemoryRequest(
        response: DebugProtocol.ReadMemoryResponse,
        args: DebugProtocol.ReadMemoryArguments
    ): Promise<void> {
        try {
            const base = parseIntValue(args.memoryReference);
            if (isNaN(base)) {
                throw new Error(`bad memory reference: ${args.memoryReference}`);
            }
            const address = base + (args.offset || 0);
            const count = Math.max(0, args.count || 0);
            const rec = await (this.gdb as GdbMi).send(
                `-data-read-memory-bytes ${hex(address)} ${count}`
            );
            const blocks = asArray(rec.results.memory).map((entry) => asTuple(entry));
            const data = Buffer.from(blocks.map((b) => miString(b.contents)).join(""), "hex");
            response.body = {
                address: hex(address),
                data: data.subarray(0, count).toString("base64"),
            };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2012, errorMessage(err));
        }
    }

    protected async writeMemoryRequest(
        response: DebugProtocol.WriteMemoryResponse,
        args: DebugProtocol.WriteMemoryArguments
    ): Promise<void> {
        try {
            const base = parseIntValue(args.memoryReference);
            if (isNaN(base)) {
                throw new Error(`bad memory reference: ${args.memoryReference}`);
            }
            const address = base + (args.offset || 0);
            const data = Buffer.from(args.data, "base64").toString("hex");
            await (this.gdb as GdbMi).send(`-data-write-memory-bytes ${hex(address)} ${data}`);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 2013, errorMessage(err));
        }
    }

    protected async terminateRequest(
        response: DebugProtocol.TerminateResponse,
        _args: DebugProtocol.TerminateArguments
    ): Promise<void> {
        this.terminating = true;
        try {
            await this.stopInferior();
            this.gdb?.close();
        } finally {
            this.sendResponse(response);
            this.sendEvent(new TerminatedEvent());
        }
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        this.terminating = true;
        try {
            if (args.terminateDebuggee !== false) {
                await this.stopInferior();
            }
            this.gdb?.close();
        } finally {
            this.sendResponse(response);
            this.sendEvent(new TerminatedEvent());
        }
    }

    /**
     * Stop a running target before closing gdb. Closing gdb while the target is
     * still running (especially through gdbserver) can leave gdbserver and the
     * inferior behind in the terminal, which then blocks the next launch.
     */
    private async stopInferior(): Promise<void> {
        if (!this.gdb) {
            return;
        }
        try {
            await this.gdb.send("-exec-abort", 2000);
        } catch {
            // Already stopped, exited, or not interruptible.
        }
        try {
            await this.gdb.send(`-interpreter-exec console ${miQuote("kill")}`, 2000);
        } catch {
            // The target may already be gone, or gdb is exiting.
        }
    }

    protected async restartRequest(
        response: DebugProtocol.RestartResponse,
        _args: DebugProtocol.RestartArguments
    ): Promise<void> {
        if (!this.launchArgs) {
            this.sendErrorResponse(response, 2014, "restart is only available for launch sessions");
            return;
        }
        try {
            if (this.gdb) {
                await this.stopInferior();
                this.gdb.removeAllListeners();
                this.gdb.close();
            }
            this.gdb = null;
            this.configured = false;
            this.pendingStop = null;
            this.entryPending = false;
            this.handles.reset();
            this.registerNames = null;
            await this.startLaunch(this.launchArgs);
            await this.reapplyBreakpoints();
            this.configured = true;
            this.sendResponse(response);
            const gdb = this.requireGdb();
            if (this.pendingStop) {
                const rec = this.pendingStop;
                this.pendingStop = null;
                if (this.stopOnEntry) {
                    this.reportStop(rec, "entry");
                } else {
                    await gdb.send("-exec-continue");
                }
            } else if (this.runInConsole) {
                if (this.stopOnEntry) {
                    this.entryPending = true;
                    await gdb.send(`-interpreter-exec console ${miQuote("starti")}`);
                } else {
                    await gdb.send("-exec-run");
                }
            }
        } catch (err) {
            this.sendErrorResponse(response, 2015, errorMessage(err));
        }
    }

    private async reapplyBreakpoints(): Promise<void> {
        for (const [sourcePath, specs] of this.sourceBreakpoints) {
            for (const spec of specs) {
                spec.gdbId = undefined;
                const bp = await this.insertSourceBreakpoint(sourcePath, spec);
                if (!bp.verified) {
                    spec.gdbId = undefined;
                }
            }
        }
        for (const spec of this.functionBreakpoints) {
            spec.gdbId = undefined;
            try {
                const rec = await (this.gdb as GdbMi).send(
                    `-break-insert -f ${miQuote(spec.name)}`
                );
                const bkpt = asTuple(rec.results.bkpt);
                const number = miNumber(bkpt.number);
                if (!isNaN(number)) {
                    spec.gdbId = number;
                    if (spec.condition) {
                        await (this.gdb as GdbMi).send(
                            `-break-condition ${number} ${miQuote(spec.condition)}`
                        );
                    }
                    if (spec.hitCondition && /^\d+$/.test(spec.hitCondition)) {
                        await (this.gdb as GdbMi).send(
                            `-break-after ${number} ${parseInt(spec.hitCondition, 10)}`
                        );
                    }
                }
            } catch {
                // leave it unverified; the client can re-send
            }
        }
        for (const spec of this.instructionBreakpoints) {
            spec.gdbId = undefined;
            try {
                const rec = await (this.gdb as GdbMi).send(
                    `-break-insert -f *${spec.address}`
                );
                const bkpt = asTuple(rec.results.bkpt);
                const number = miNumber(bkpt.number);
                if (!isNaN(number)) {
                    spec.gdbId = number;
                }
            } catch {
                // leave it unverified; the client can re-send
            }
        }
    }

    private onStop(rec: MiRecord): void {
        const reason = miString(rec.results.reason);
        const thread = miNumber(rec.results["thread-id"]);
        if (!isNaN(thread)) {
            this.threadId = thread;
        }
        if (reason === "exited-normally" || reason === "exited") {
            const code = miNumber(rec.results["exit-code"]);
            this.terminating = true;
            this.sendEvent(new ExitedEvent(isNaN(code) ? 0 : code));
            this.sendEvent(new TerminatedEvent());
            this.gdb?.close();
            return;
        }
        if (this.entryPending) {
            this.entryPending = false;
            this.reportStop(rec, "entry");
            return;
        }
        if (!this.configured) {
            this.pendingStop = rec;
            return;
        }
        this.reportStop(rec);
    }

    private reportStop(rec: MiRecord, forcedReason?: string): void {
        const reason = miString(rec.results.reason);
        const signal = miString(rec.results["signal-name"]);
        const bkptno = miNumber(rec.results.bkptno);
        let dapReason = forcedReason || "breakpoint";
        let text: string | undefined;
        const hitBreakpointIds: number[] = [];
        if (!forcedReason) {
            switch (reason) {
                case "breakpoint-hit":
                    dapReason = "breakpoint";
                    if (!isNaN(bkptno)) {
                        hitBreakpointIds.push(bkptno);
                    }
                    break;
                case "end-stepping-range":
                case "function-finished":
                    dapReason = "step";
                    break;
                case "watchpoint-trigger":
                case "read-watchpoint-trigger":
                case "access-watchpoint-trigger":
                    dapReason = "data breakpoint";
                    break;
                case "signal-received":
                    dapReason = "exception";
                    text = signal ? `signal ${signal}` : "signal received";
                    break;
                case "exited-signalled":
                    dapReason = "exception";
                    text = `exited with signal ${signal}`;
                    break;
                default:
                    dapReason = "pause";
                    text = reason || undefined;
            }
        }
        this.handles.reset();
        const event = new StoppedEvent(dapReason, this.threadId, text);
        (event.body as DebugProtocol.StoppedEvent["body"]).allThreadsStopped = true;
        if (hitBreakpointIds.length > 0) {
            (event.body as DebugProtocol.StoppedEvent["body"]).hitBreakpointIds = hitBreakpointIds;
        }
        this.sendEvent(event);
    }

    private requireGdb(): GdbMi {
        if (!this.gdb) {
            throw new Error("gdb is not running");
        }
        return this.gdb;
    }

    private sourcePath(input: string): string {
        return path.isAbsolute(input) ? input : path.resolve(this.cwd, input);
    }

    private makeSource(file: string): Source | undefined {
        if (!file) {
            return undefined;
        }
        const full = path.isAbsolute(file) ? file : path.resolve(this.cwd, file);
        return new Source(path.basename(full), full);
    }

    private cleanup(): void {
        this.terminating = true;
        this.gdb?.close();
        this.gdb = null;
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function readLittleEndian(hexWord: string): number {
    let value = 0n;
    for (let i = 0; i < hexWord.length; i += 2) {
        value |= BigInt(parseInt(hexWord.slice(i, i + 2), 16)) << BigInt((i / 2) * 8);
    }
    return Number(value & 0xffffffffffffffffn);
}

function readBufferLittleEndian(bytes: Buffer, width: number): number {
    let value = 0n;
    for (let i = 0; i < width && i < bytes.length; i++) {
        value |= BigInt(bytes[i]) << BigInt(i * 8);
    }
    return Number(value & 0xffffffffffffffffn);
}

function decodeUserString(text: string): Buffer {
    const body = text.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== "\\" || i + 1 >= body.length) {
            bytes.push(...Buffer.from(ch, "utf8"));
            continue;
        }
        const next = body[++i];
        const simple: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            v: "\v",
            f: "\f",
            a: "\x07",
            e: "\x1b",
            "0": "\0",
            "\\": "\\",
            "'": "'",
            '"': '"',
            "`": "`",
        };
        if (simple[next] !== undefined) {
            bytes.push(...Buffer.from(simple[next], "utf8"));
        } else if (next === "x" && i + 2 < body.length) {
            const hex = body.slice(i + 1, i + 3);
            if (/^[0-9a-f]{2}$/i.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
            } else {
                bytes.push(next.charCodeAt(0));
            }
        } else {
            bytes.push(next.charCodeAt(0));
        }
    }
    return Buffer.from(bytes);
}

function parseUserNumber(text: string): number | undefined {
    const value = text.trim();
    if (/^'.'$/.test(value) || /^"."$/.test(value)) {
        return value.charCodeAt(1);
    }
    if (/^[-+]?0x[0-9a-f]+$/i.test(value)) {
        return parseInt(value.replace(/^([-+]?)0x/i, "$1"), 16);
    }
    if (/^[-+]?0b[01]+$/i.test(value)) {
        return parseInt(value.replace(/^([-+]?)0b/i, "$1"), 2);
    }
    if (/^[-+]?0o[0-7]+$/i.test(value)) {
        return parseInt(value.replace(/^([-+]?)0o/i, "$1"), 8);
    }
    if (/^[-+]?\d+$/.test(value)) {
        return parseInt(value, 10);
    }
    return undefined;
}

function encodeLittleEndian(value: number, width: number): Buffer {
    let remaining = BigInt(Math.trunc(value));
    if (remaining < 0n) {
        remaining = (1n << BigInt(width * 8)) + remaining;
    }
    const bytes = Buffer.alloc(width);
    for (let i = 0; i < width; i++) {
        bytes[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return bytes;
}

DebugSession.run(NasmDebugSession);
