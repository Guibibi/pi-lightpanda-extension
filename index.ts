import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EXTENSION_NAME = "lightpanda";
const DEFAULT_CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_WAIT_MS = 5000;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const MAX_SEARCH_RESULTS = 10;
const SCREENSHOT_WARNING =
	"Lightpanda currently has no graphical rendering engine; Page.captureScreenshot returns a placeholder image, not a real visual page render.";

type ProcessResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

type CdpSessionMode = "auto" | "page" | "browser" | "none";

type CdpEvent = {
	timestamp: string;
	method: string;
	params?: unknown;
	sessionId?: string;
};

const NativeWebSocket: any = (globalThis as any).WebSocket;

let managedServer: ChildProcess | undefined;
let serverInfo:
	| {
			host: string;
			port: number;
			wsEndpoint: string;
			managed: boolean;
			startedAt?: string;
			args?: string[];
		}
	| undefined;
let cdpClient: CdpClient | undefined;
const lightpandaLogs: string[] = [];

function text(text: string) {
	return { type: "text" as const, text };
}

function image(data: string, mimeType = "image/png") {
	return { type: "image" as const, data, mimeType };
}

function extensionEnv() {
	return {
		...process.env,
		LIGHTPANDA_DISABLE_TELEMETRY: process.env.LIGHTPANDA_DISABLE_TELEMETRY ?? "true",
	};
}

function lightpandaBinary() {
	const configured = process.env.LIGHTPANDA_BIN ?? process.env.LIGHTPANDA_PATH;
	if (configured) return configured;

	const home = process.env.HOME;
	if (home) {
		const local = join(home, ".local", "bin", "lightpanda");
		if (existsSync(local)) return local;
	}
	return "lightpanda";
}

function normalizePathArg(path: string, cwd: string) {
	let p = path.startsWith("@") ? path.slice(1) : path;
	if (p.startsWith("~/")) {
		const home = process.env.HOME;
		if (home) p = join(home, p.slice(2));
	}
	return resolve(cwd, p);
}

function pushLog(line: string) {
	for (const entry of line.split(/\r?\n/)) {
		const trimmed = entry.trimEnd();
		if (!trimmed) continue;
		lightpandaLogs.push(`${new Date().toISOString()} ${trimmed}`);
	}
	while (lightpandaLogs.length > 200) lightpandaLogs.shift();
}

function parseInteger(value: unknown, fallback: number, min: number, max: number) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.max(min, Math.min(max, n));
}

function formatJson(value: unknown) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

async function writeTempText(prefix: string, filename: string, content: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const file = join(dir, filename);
	await writeFile(file, content, "utf8");
	return file;
}

async function makeTextResult<TDetails extends Record<string, unknown>>(
	body: string,
	details: TDetails,
	mode: "head" | "tail" = "head",
): Promise<AgentToolResult<TDetails & Record<string, unknown>>> {
	const outputBody = body.trim().length > 0 ? body : "[No text output.]";
	const truncation = (mode === "tail" ? truncateTail : truncateHead)(outputBody, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let output = truncation.content;
	let nextDetails: TDetails & Record<string, unknown> = details;

	if (truncation.truncated) {
		const fullOutputPath = await writeTempText("pi-lightpanda-", "output.txt", body);
		nextDetails = {
			...details,
			truncation,
			fullOutputPath,
		};
		output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines `;
		output += `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). `;
		output += `Full output saved to: ${fullOutputPath}]`;
	}

	return {
		content: [text(output)],
		details: nextDetails,
	};
}

async function runProcess(
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: options.env ?? extensionEnv(),
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (options.signal) options.signal.removeEventListener("abort", killProcess);
			resolve(result);
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (err) => {
			finish({ stdout, stderr: stderr + String(err), code: 127, killed });
		});
		proc.on("close", (code) => {
			finish({ stdout, stderr, code: code ?? 0, killed });
		});

		if (options.signal) {
			if (options.signal.aborted) killProcess();
			else options.signal.addEventListener("abort", killProcess, { once: true });
		}
		if (options.timeout && options.timeout > 0) {
			timeoutId = setTimeout(killProcess, options.timeout);
		}
	});
}

function commonLightpandaArgs(params: Record<string, unknown>) {
	const args: string[] = [];
	if (params.obeyRobots) args.push("--obey-robots");
	if (params.blockPrivateNetworks) args.push("--block-private-networks");
	if (typeof params.blockCidrs === "string" && params.blockCidrs.trim()) args.push("--block-cidrs", params.blockCidrs.trim());
	if (typeof params.httpProxy === "string" && params.httpProxy.trim()) args.push("--http-proxy", params.httpProxy.trim());
	if (typeof params.userAgentSuffix === "string" && params.userAgentSuffix.trim()) {
		args.push("--user-agent-suffix", params.userAgentSuffix.trim());
	}
	if (params.insecureDisableTlsHostVerification) args.push("--insecure-disable-tls-host-verification");
	if (typeof params.httpTimeoutMs === "number" && params.httpTimeoutMs > 0) {
		args.push("--http-timeout", String(Math.trunc(params.httpTimeoutMs)));
	}
	const maxResponseSize = parseInteger(params.httpMaxResponseSize, DEFAULT_HTTP_MAX_RESPONSE_SIZE, 0, 1_000_000_000);
	if (maxResponseSize > 0) args.push("--http-max-response-size", String(maxResponseSize));
	return args;
}

async function runLightpandaFetch(
	params: Record<string, unknown> & {
		url: string;
		dump: "html" | "markdown" | "semantic_tree" | "semantic_tree_text";
		stripMode?: string;
		waitMs?: number;
		waitUntil?: string;
		waitSelector?: string;
		waitScript?: string;
		withFrames?: boolean;
		withBase?: boolean;
		terminateMs?: number;
		timeoutMs?: number;
	},
	signal?: AbortSignal,
): Promise<ProcessResult & { args: string[]; binary: string }> {
	const binary = lightpandaBinary();
	const args = [
		"fetch",
		"--dump",
		params.dump,
		"--log-level",
		"fatal",
		"--log-format",
		"logfmt",
		...commonLightpandaArgs(params),
	];

	if (params.stripMode) args.push("--strip-mode", params.stripMode);
	if (params.withFrames) args.push("--with-frames");
	if (params.withBase) args.push("--with-base");
	if (typeof params.waitMs === "number") args.push("--wait-ms", String(Math.trunc(params.waitMs)));
	if (params.waitUntil) args.push("--wait-until", params.waitUntil);
	if (params.waitSelector) args.push("--wait-selector", params.waitSelector);
	if (params.waitScript) args.push("--wait-script", params.waitScript);
	if (typeof params.terminateMs === "number" && params.terminateMs > 0) {
		args.push("--terminate-ms", String(Math.trunc(params.terminateMs)));
	}
	args.push(params.url);

	const result = await runProcess(binary, args, {
		timeout: parseInteger(params.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS, 1_000, 10 * 60_000),
		signal,
	});
	return { ...result, args, binary };
}

async function capturePlaywrightScreenshot(
	params: Record<string, unknown> & {
		url: string;
		path?: string;
		fullPage?: boolean;
		waitUntil?: "load" | "domcontentloaded" | "networkidle";
		waitSelector?: string;
		waitScript?: string;
		waitMs?: number;
		timeoutMs?: number;
		viewportWidth?: number;
		viewportHeight?: number;
		deviceScaleFactor?: number;
		colorScheme?: "light" | "dark" | "no-preference";
	},
	cwd: string,
	signal?: AbortSignal,
) {
	const startedAt = Date.now();
	const timeoutMs = parseInteger(params.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS, 1_000, 10 * 60_000);
	const viewport = {
		width: parseInteger(params.viewportWidth, DEFAULT_VIEWPORT_WIDTH, 100, 10_000),
		height: parseInteger(params.viewportHeight, DEFAULT_VIEWPORT_HEIGHT, 100, 10_000),
	};
	const deviceScaleFactor =
		typeof params.deviceScaleFactor === "number" && Number.isFinite(params.deviceScaleFactor)
			? Math.max(0.1, Math.min(5, params.deviceScaleFactor))
			: 1;
	const colorScheme = ["light", "dark", "no-preference"].includes(String(params.colorScheme)) ? params.colorScheme : undefined;
	const waitUntil = params.waitUntil ?? "networkidle";
	const outputPath = params.path
		? normalizePathArg(params.path, cwd)
		: join(await mkdtemp(join(tmpdir(), "pi-playwright-shot-")), "screenshot.png");

	let browser: any;
	const abort = () => {
		try {
			void browser?.close?.();
		} catch {
			// Ignore close failures during cancellation.
		}
	};

	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) throw new Error("Cancelled");
		const { chromium } = await import("playwright");
		browser = await chromium.launch({
			headless: true,
			args: ["--no-sandbox"],
		});
		if (signal?.aborted) throw new Error("Cancelled");

		const context = await browser.newContext({
			viewport,
			deviceScaleFactor,
			...(colorScheme ? { colorScheme } : {}),
		});
		const page = await context.newPage();
		await page.goto(params.url, { waitUntil, timeout: timeoutMs });
		if (params.waitSelector?.trim()) {
			await page.waitForSelector(params.waitSelector.trim(), { timeout: timeoutMs });
		}
		if (params.waitScript?.trim()) {
			await page.waitForFunction(params.waitScript.trim(), undefined, { timeout: timeoutMs });
		}
		if (typeof params.waitMs === "number" && params.waitMs > 0) {
			await page.waitForTimeout(Math.trunc(params.waitMs));
		}

		const pageInfo = await page
			.evaluate(() => ({
				title: document.title,
				url: location.href,
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
				scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
			}))
			.catch(() => undefined);
		const screenshot = await page.screenshot({
			type: "png",
			fullPage: Boolean(params.fullPage),
		});

		await withFileMutationQueue(outputPath, async () => {
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, screenshot);
		});

		return {
			outputPath,
			base64: screenshot.toString("base64"),
			bytes: screenshot.byteLength,
			elapsedMs: Date.now() - startedAt,
			viewport,
			deviceScaleFactor,
			fullPage: Boolean(params.fullPage),
			waitUntil,
			pageInfo,
		};
	} catch (err) {
		if (signal?.aborted) throw new Error("Cancelled");
		throw err;
	} finally {
		signal?.removeEventListener("abort", abort);
		try {
			await browser?.close?.();
		} catch {
			// Ignore browser cleanup failures.
		}
	}
}

function unescapeMarkdown(value: string) {
	return value
		.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/__(.*?)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

function decodeBase64Url(value: string) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

function cleanSearchUrl(url: string) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.endsWith("bing.com") && parsed.searchParams.get("u")) {
			const encoded = parsed.searchParams.get("u")!;
			if (encoded.startsWith("a1")) return decodeBase64Url(encoded.slice(2));
		}
		const yahooMatch = parsed.pathname.match(/\/RU=([^/]+)\//);
		if (yahooMatch) return decodeURIComponent(yahooMatch[1]);
	} catch {
		// Keep the original URL.
	}
	return url;
}

function parseSearchResults(markdown: string, maxResults: number): SearchResult[] {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Search Results/i.test(line.trim()));
	const relevant = lines.slice(start >= 0 ? start + 1 : 0);
	const blocks: string[][] = [];
	let current: string[] = [];

	for (const line of relevant) {
		if (/^\s*\d+\.\s*$/.test(line)) {
			if (current.length > 0) blocks.push(current);
			current = [line];
			continue;
		}
		if (current.length > 0) current.push(line);
	}
	if (current.length > 0) blocks.push(current);

	const results: SearchResult[] = [];
	for (const block of blocks.length > 0 ? blocks : [relevant]) {
		let title = "";
		let url = "";
		let titleIndex = -1;
		let urlIndex = -1;

		for (let i = 0; i < block.length; i++) {
			const line = block[i].trim();
			let match = line.match(/^#{2,4}\s+\[([^\]]+)]\((https?:\/\/[^)]+)\)/);
			if (match) {
				title = unescapeMarkdown(match[1]);
				url = cleanSearchUrl(match[2]);
				titleIndex = i;
				urlIndex = i;
				break;
			}
			match = line.match(/^#{2,4}\s+(.+)$/);
			if (match && !/^(Search Results|Videos|Images|News|More)$/i.test(match[1].trim())) {
				title = unescapeMarkdown(match[1]);
				titleIndex = i;
				break;
			}
		}

		if (title && !url) {
			for (let i = titleIndex + 1; i < Math.min(block.length, titleIndex + 8); i++) {
				const line = block[i].trim();
				const match = line.match(/^\[[^\]]*]\((https?:\/\/[^)]+)\)/) ?? line.match(/^\[(https?:\/\/[^\]]+)]\((https?:\/\/[^)]+)\)/);
				if (match) {
					url = cleanSearchUrl(match[2] ?? match[1]);
					urlIndex = i;
					break;
				}
			}
		}

		if (!title || !url || results.some((result) => result.url === url)) continue;

		const snippetLines: string[] = [];
		for (let i = Math.max(titleIndex, urlIndex) + 1; i < block.length; i++) {
			const raw = block[i].trim();
			if (!raw) {
				if (snippetLines.length > 0) break;
				continue;
			}
			if (/^[-*]\s+\[/.test(raw) || /^!\[/.test(raw) || /^#{2,4}\s+/.test(raw)) break;
			if (/^\[.*]\(https?:\/\//.test(raw)) continue;
			if (/^https?:\/\//.test(raw)) continue;
			if (/^[\w.-]+https?:\/\//.test(raw)) continue;
			snippetLines.push(unescapeMarkdown(raw));
			if (snippetLines.join(" ").length > 500 || snippetLines.length >= 4) break;
		}

		results.push({
			title,
			url,
			snippet: snippetLines.join(" ").replace(/\s+/g, " ").trim() || undefined,
		});
		if (results.length >= maxResults) break;
	}

	if (results.length === 0) {
		const linkPattern = /^#{2,4}\s+\[([^\]]+)]\((https?:\/\/[^)]+)\)/gm;
		for (const match of markdown.matchAll(linkPattern)) {
			const title = unescapeMarkdown(match[1]);
			const url = cleanSearchUrl(match[2]);
			if (!results.some((result) => result.url === url)) results.push({ title, url });
			if (results.length >= maxResults) break;
		}
	}

	return results;
}

async function fetchJsonVersion(host: string, port: number, timeoutMs = 800) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
		if (!response.ok) return undefined;
		return (await response.json()) as { webSocketDebuggerUrl?: string; Browser?: string; [key: string]: unknown };
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function waitForServer(host: string, port: number, timeoutMs: number) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const version = await fetchJsonVersion(host, port);
		if (version) return version;
		await delay(100);
	}
	return undefined;
}

async function ensureServer(params: Record<string, unknown>, signal?: AbortSignal) {
	const host = typeof params.host === "string" && params.host.trim() ? params.host.trim() : DEFAULT_CDP_HOST;
	const port = parseInteger(params.port, DEFAULT_CDP_PORT, 1, 65_535);

	if (serverInfo && serverInfo.host === host && serverInfo.port === port) {
		const version = await fetchJsonVersion(host, port);
		if (version) {
			serverInfo.wsEndpoint = version.webSocketDebuggerUrl ?? `ws://${host}:${port}/`;
			return { ...serverInfo, version };
		}
	}

	const existing = await fetchJsonVersion(host, port);
	if (existing) {
		serverInfo = {
			host,
			port,
			wsEndpoint: existing.webSocketDebuggerUrl ?? `ws://${host}:${port}/`,
			managed: false,
		};
		return { ...serverInfo, version: existing };
	}

	const binary = lightpandaBinary();
	const args = [
		"serve",
		"--host",
		host,
		"--port",
		String(port),
		"--log-level",
		typeof params.logLevel === "string" ? params.logLevel : "warn",
		"--log-format",
		"logfmt",
		...commonLightpandaArgs(params),
	];

	pushLog(`starting ${binary} ${args.join(" ")}`);
	const child = spawn(binary, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: extensionEnv(),
	});
	managedServer = child;
	child.stdout.on("data", (data) => pushLog(String(data)));
	child.stderr.on("data", (data) => pushLog(String(data)));
	child.on("error", (err) => pushLog(`process error: ${String(err)}`));
	child.on("exit", (code, childSignal) => {
		pushLog(`process exited code=${code ?? "null"} signal=${childSignal ?? "null"}`);
		if (managedServer === child) managedServer = undefined;
		if (serverInfo?.managed) serverInfo = undefined;
		cdpClient?.close();
		cdpClient = undefined;
	});

	if (signal?.aborted) child.kill("SIGTERM");
	const abort = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const startupTimeoutMs = parseInteger(params.startupTimeoutMs, 5_000, 500, 60_000);
		const version = await waitForServer(host, port, startupTimeoutMs);
		if (!version) {
			child.kill("SIGTERM");
			throw new Error(`Lightpanda CDP server did not become ready on ${host}:${port}. Recent logs:\n${lightpandaLogs.slice(-20).join("\n")}`);
		}
		serverInfo = {
			host,
			port,
			wsEndpoint: version.webSocketDebuggerUrl ?? `ws://${host}:${port}/`,
			managed: true,
			startedAt: new Date().toISOString(),
			args,
		};
		return { ...serverInfo, version };
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

async function stopServer() {
	cdpClient?.close();
	cdpClient = undefined;

	if (!managedServer) {
		const previous = serverInfo;
		serverInfo = undefined;
		return { stopped: false, reason: previous?.managed === false ? "Connected server was external; not killed." : "No managed Lightpanda server running." };
	}

	const child = managedServer;
	managedServer = undefined;
	serverInfo = undefined;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		delay(2000).then(() => {
			if (!child.killed) child.kill("SIGKILL");
		}),
	]);
	return { stopped: true };
}

function defaultSessionForMethod(method: string): CdpSessionMode {
	const domain = method.split(".", 1)[0];
	if (["Target", "Browser"].includes(domain)) return "none";
	return "page";
}

class CdpClient {
	private ws: any;
	private nextId = 1;
	private pending = new Map<
		number,
		{
			resolve: (value: any) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	private waiters: Array<{
		predicate: (event: CdpEvent) => boolean;
		resolve: (event: CdpEvent | undefined) => void;
		timer: NodeJS.Timeout;
	}> = [];
	events: CdpEvent[] = [];
	targetId?: string;
	sessionId?: string;

	constructor(readonly wsEndpoint: string) {}

	get isOpen() {
		return this.ws?.readyState === 1;
	}

	async connect(signal?: AbortSignal) {
		if (!NativeWebSocket) throw new Error("No native WebSocket implementation is available in this Node runtime.");
		if (this.isOpen) return;
		this.ws = new NativeWebSocket(this.wsEndpoint);

		await new Promise<void>((resolvePromise, rejectPromise) => {
			const cleanup = () => {
				this.ws?.removeEventListener?.("open", onOpen);
				this.ws?.removeEventListener?.("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};
			const onOpen = () => {
				cleanup();
				resolvePromise();
			};
			const onError = (event: any) => {
				cleanup();
				rejectPromise(new Error(`WebSocket connection failed: ${event?.message ?? "unknown error"}`));
			};
			const onAbort = () => {
				cleanup();
				this.close();
				rejectPromise(new Error("Cancelled"));
			};
			this.ws.addEventListener("open", onOpen, { once: true });
			this.ws.addEventListener("error", onError, { once: true });
			signal?.addEventListener("abort", onAbort, { once: true });
		});

		this.ws.addEventListener("message", (event: any) => this.onMessage(event));
		this.ws.addEventListener("close", () => this.rejectAllPending(new Error("CDP WebSocket closed")));
	}

	close() {
		try {
			this.ws?.close?.();
		} catch {
			// Ignore close failures.
		}
		this.rejectAllPending(new Error("CDP client closed"));
	}

	private rejectAllPending(err: Error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(undefined);
		}
		this.waiters = [];
	}

	private onMessage(event: any) {
		const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			pushLog(`invalid CDP JSON: ${raw.slice(0, 500)}`);
			return;
		}

		if (typeof message.id === "number" && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(`${message.error.message ?? "CDP error"} (${message.error.code ?? "unknown"})`));
			else pending.resolve(message.result ?? {});
			return;
		}

		if (message.method) {
			const cdpEvent: CdpEvent = {
				timestamp: new Date().toISOString(),
				method: message.method,
				params: message.params,
				sessionId: message.sessionId,
			};
			this.events.push(cdpEvent);
			while (this.events.length > 300) this.events.shift();

			if (message.method === "Target.attachedToTarget" && message.params?.sessionId) {
				this.sessionId = message.params.sessionId;
				this.targetId = message.params.targetInfo?.targetId ?? this.targetId;
			}

			for (const waiter of [...this.waiters]) {
				if (waiter.predicate(cdpEvent)) {
					clearTimeout(waiter.timer);
					this.waiters = this.waiters.filter((item) => item !== waiter);
					waiter.resolve(cdpEvent);
				}
			}
		}
	}

	async command(method: string, params: Record<string, unknown> = {}, session: CdpSessionMode = "auto", timeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS) {
		if (!this.isOpen) await this.connect();
		const id = this.nextId++;
		const message: Record<string, unknown> = { id, method, params };
		const effectiveSession = session === "auto" ? defaultSessionForMethod(method) : session;
		if (effectiveSession === "page") {
			if (!this.sessionId) throw new Error(`No page CDP session is attached; call ${EXTENSION_NAME}_cdp_navigate or start a page first.`);
			message.sessionId = this.sessionId;
		}

		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});

		this.ws.send(JSON.stringify(message));
		return promise;
	}

	async initPage() {
		if (this.targetId && this.sessionId) return;
		let targetId = this.targetId;
		if (!targetId) {
			const targets = (await this.command("Target.getTargets", {}, "none")) as { targetInfos?: Array<{ targetId: string; type: string }> };
			targetId = targets.targetInfos?.find((target) => target.type === "page")?.targetId;
		}
		if (!targetId) {
			const created = (await this.command("Target.createTarget", { url: "about:blank" }, "none")) as { targetId: string };
			targetId = created.targetId;
		}
		this.targetId = targetId;
		const attached = (await this.command("Target.attachToTarget", { targetId, flatten: true }, "none")) as { sessionId: string };
		this.sessionId = attached.sessionId;

		for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) {
			try {
				await this.command(method, {}, "page", 5000);
			} catch (err) {
				pushLog(`${method} failed: ${String(err)}`);
			}
		}
		try {
			await this.command("Page.setLifecycleEventsEnabled", { enabled: true }, "page", 5000);
		} catch {
			// Optional in Lightpanda; ignore if unsupported.
		}
	}

	waitForEvent(predicate: (event: CdpEvent) => boolean, timeoutMs: number) {
		return new Promise<CdpEvent | undefined>((resolvePromise) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
				resolvePromise(undefined);
			}, timeoutMs);
			this.waiters.push({ predicate, resolve: resolvePromise, timer });
		});
	}

	async navigate(url: string, waitUntil: string, waitMs: number) {
		await this.initPage();
		const waitPromise =
			waitMs > 0 ? this.waitForEvent((event) => navigationEventMatches(event, waitUntil), waitMs) : Promise.resolve(undefined);
		const result = await this.command("Page.navigate", { url }, "page");
		const waitedFor = await waitPromise;
		return { result, waitedFor };
	}

	async evaluate(expression: string, timeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS) {
		await this.initPage();
		return this.command(
			"Runtime.evaluate",
			{
				expression,
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			},
			"page",
			timeoutMs,
		);
	}

	async pageSummary() {
		const summaryScript = `(() => JSON.stringify({
			title: document.title || "",
			url: location.href,
			readyState: document.readyState,
			links: document.links ? document.links.length : 0,
			forms: document.forms ? document.forms.length : 0,
			bodyPreview: document.body ? document.body.innerText.slice(0, 1000) : ""
		}))()`;
		const result = (await this.evaluate(summaryScript)) as any;
		const value = result?.result?.value ?? result?.result?.description;
		if (typeof value === "string") {
			try {
				return JSON.parse(value);
			} catch {
				return { value };
			}
		}
		return result;
	}
}

function navigationEventMatches(event: CdpEvent, waitUntil: string) {
	if (waitUntil === "domcontentloaded") return event.method === "Page.domContentEventFired";
	if (waitUntil === "networkidle") return event.method === "Page.lifecycleEvent" && (event.params as any)?.name === "networkIdle";
	return event.method === "Page.loadEventFired" || event.method === "Page.frameStoppedLoading";
}

async function getClient(params: Record<string, unknown>, signal?: AbortSignal) {
	const info = await ensureServer(params, signal);
	if (!cdpClient || cdpClient.wsEndpoint !== info.wsEndpoint || !cdpClient.isOpen) {
		cdpClient?.close();
		cdpClient = new CdpClient(info.wsEndpoint);
		await cdpClient.connect(signal);
	}
	await cdpClient.initPage();
	return { client: cdpClient, info };
}

function recentDiagnostics(client?: CdpClient, limit = 30) {
	const events = client?.events.slice(-limit) ?? [];
	return {
		events,
		logs: lightpandaLogs.slice(-limit),
	};
}

function serverStatusText(version?: Record<string, unknown>) {
	const info = serverInfo;
	const lines = [`Lightpanda binary: ${lightpandaBinary()}`];
	if (version?.Browser) lines.push(`Browser: ${String(version.Browser)}`);
	if (info) {
		lines.push(`CDP: ${info.wsEndpoint} (${info.managed ? "managed by Pi" : "external"})`);
		if (info.startedAt) lines.push(`Started: ${info.startedAt}`);
		if (managedServer?.pid) lines.push(`PID: ${managedServer.pid}`);
		if (cdpClient?.isOpen) lines.push(`CDP client: connected${cdpClient.sessionId ? ` (session ${cdpClient.sessionId})` : ""}`);
	} else {
		lines.push("CDP: not running/connected");
	}
	if (lightpandaLogs.length > 0) {
		lines.push("", "Recent Lightpanda logs:", ...lightpandaLogs.slice(-8));
	}
	return lines.join("\n");
}

const networkOptionSchema = {
	obeyRobots: Type.Optional(Type.Boolean({ description: "Pass --obey-robots to Lightpanda." })),
	blockPrivateNetworks: Type.Optional(Type.Boolean({ description: "Pass --block-private-networks to prevent requests to private/internal IP ranges." })),
	blockCidrs: Type.Optional(Type.String({ description: "Additional CIDR ranges to block/allow, matching Lightpanda --block-cidrs syntax." })),
	httpProxy: Type.Optional(Type.String({ description: "HTTP proxy URL for Lightpanda requests." })),
	userAgentSuffix: Type.Optional(Type.String({ description: "Suffix appended to Lightpanda's User-Agent." })),
	insecureDisableTlsHostVerification: Type.Optional(Type.Boolean({ description: "Disable TLS host verification. Use only when explicitly needed." })),
	httpTimeoutMs: Type.Optional(Type.Number({ description: "HTTP transfer timeout in milliseconds." })),
	httpMaxResponseSize: Type.Optional(Type.Number({ description: "Maximum response size accepted by Lightpanda. Default: 10MB." })),
};

const cdpServerOptionSchema = {
	host: Type.Optional(Type.String({ description: "CDP host. Default: 127.0.0.1." })),
	port: Type.Optional(Type.Number({ description: "CDP port. Default: 9222." })),
	startupTimeoutMs: Type.Optional(Type.Number({ description: "How long to wait for Lightpanda serve startup. Default: 5000." })),
	logLevel: Type.Optional(StringEnum(["debug", "info", "warn", "error", "fatal"] as const)),
	...networkOptionSchema,
};

export default function lightpandaExtension(pi: ExtensionAPI) {
	pi.registerCommand("lightpanda", {
		description: "Manage the Lightpanda CDP server: status, start, stop, restart",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			try {
				if (action === "start") {
					const info = await ensureServer({}, ctx.signal);
					ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
					ctx.ui.notify(`Lightpanda CDP ready at ${info.wsEndpoint}`, "info");
					return;
				}
				if (action === "stop") {
					const stopped = await stopServer();
					ctx.ui.setStatus("lightpanda", undefined);
					ctx.ui.notify(stopped.stopped ? "Lightpanda stopped" : (stopped.reason ?? "No managed Lightpanda server running."), "info");
					return;
				}
				if (action === "restart") {
					await stopServer();
					const info = await ensureServer({}, ctx.signal);
					ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
					ctx.ui.notify(`Lightpanda restarted at ${info.wsEndpoint}`, "info");
					return;
				}
				const version = serverInfo ? await fetchJsonVersion(serverInfo.host, serverInfo.port) : undefined;
				ctx.ui.notify(serverStatusText(version), "info");
			} catch (err) {
				ctx.ui.notify(`Lightpanda ${action} failed: ${String(err)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "lightpanda_search",
		label: "Lightpanda Search",
		description: `Search the web with a public search results page fetched through Lightpanda. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file if truncated.`,
		promptSnippet: "Search the web using Lightpanda and return extracted result titles, URLs, and snippets.",
		promptGuidelines: [
			"Use lightpanda_search when the user asks for current web information or external documentation lookup.",
			"If lightpanda_search returns weak or blocked search results, use lightpanda_fetch on known URLs or ask the user for a source URL.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			maxResults: Type.Optional(Type.Number({ description: "Maximum results to return, 1-10. Default: 5." })),
			waitMs: Type.Optional(Type.Number({ description: "Lightpanda wait time before dumping search page. Default: 5000." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Process timeout. Default: 30000." })),
			...networkOptionSchema,
		}),
		async execute(_toolCallId, params, signal) {
			const maxResults = parseInteger(params.maxResults, 5, 1, MAX_SEARCH_RESULTS);
			const searchUrl = `https://search.yahoo.com/search?p=${encodeURIComponent(params.query)}`;
			const result = await runLightpandaFetch(
				{
					...params,
					url: searchUrl,
					dump: "markdown",
					stripMode: "full",
					waitMs: params.waitMs ?? DEFAULT_WAIT_MS,
					terminateMs: 15_000,
					timeoutMs: params.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
				},
				signal,
			);

			if (result.code !== 0 && !result.stdout.trim()) {
				throw new Error(`Lightpanda search failed (exit ${result.code}).\n${result.stderr}`);
			}

			const results = parseSearchResults(result.stdout, maxResults);
			let body = `Search query: ${params.query}\nSearch URL: ${searchUrl}\nEngine page: Yahoo Search (fetched with Lightpanda)\n`;
			if (result.code !== 0) {
				body += `\nNote: Lightpanda exited with code ${result.code}, but emitted parseable stdout. Stderr tail:\n${result.stderr.split(/\r?\n/).slice(-8).join("\n")}\n`;
			}
			if (results.length === 0) {
				body += "\nNo structured results could be extracted. Raw markdown follows.\n\n" + result.stdout;
			} else {
				body += `\nExtracted ${results.length} result(s):\n`;
				for (const [index, item] of results.entries()) {
					body += `\n${index + 1}. ${item.title}\n   ${item.url}`;
					if (item.snippet) body += `\n   ${item.snippet}`;
					body += "\n";
				}
			}

			return makeTextResult(body, {
				query: params.query,
				searchUrl,
				results,
				exitCode: result.code,
				stderrTail: result.stderr.split(/\r?\n/).slice(-20).join("\n"),
				command: [result.binary, ...result.args].join(" "),
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_fetch",
		label: "Lightpanda Fetch",
		description: `Fetch a URL with Lightpanda and dump html, markdown, semantic_tree, or semantic_tree_text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file if truncated.`,
		promptSnippet: "Fetch a web page through Lightpanda and return markdown, HTML, or a semantic tree.",
		promptGuidelines: [
			"Use lightpanda_fetch to read a page URL before reasoning about its content.",
			"Prefer lightpanda_fetch with dump=markdown for documents and dump=semantic_tree_text for AI-friendly page structure.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch." }),
			dump: Type.Optional(StringEnum(["markdown", "html", "semantic_tree", "semantic_tree_text"] as const)),
			stripMode: Type.Optional(Type.String({ description: "Comma-separated Lightpanda strip mode: js,ui,css,full. Defaults to full for markdown." })),
			waitMs: Type.Optional(Type.Number({ description: "Wait time in milliseconds before dumping." })),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle", "done"] as const)),
			waitSelector: Type.Optional(Type.String({ description: "CSS selector to wait for before dumping." })),
			waitScript: Type.Optional(Type.String({ description: "JavaScript expression to wait for before dumping." })),
			withFrames: Type.Optional(Type.Boolean({ description: "Include iframe contents." })),
			withBase: Type.Optional(Type.Boolean({ description: "Add a base tag in HTML dumps." })),
			terminateMs: Type.Optional(Type.Number({ description: "Hard JavaScript execution deadline in milliseconds." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Process timeout. Default: 30000." })),
			...networkOptionSchema,
		}),
		async execute(_toolCallId, params, signal) {
			const dump = params.dump ?? "markdown";
			const request = {
				...params,
				dump,
				stripMode: params.stripMode ?? (dump === "markdown" ? "full" : undefined),
				timeoutMs: params.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
			};
			const attempts: Array<{
				reason: string;
				command: string;
				exitCode: number;
				stdoutBytes: number;
				stderrTail: string;
			}> = [];
			let result = await runLightpandaFetch(request, signal);
			attempts.push({
				reason: "initial",
				command: [result.binary, ...result.args].join(" "),
				exitCode: result.code,
				stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
				stderrTail: result.stderr.split(/\r?\n/).slice(-20).join("\n"),
			});

			if (dump === "markdown" && result.code === 0 && !result.stdout.trim() && params.waitUntil !== "networkidle") {
				result = await runLightpandaFetch(
					{
						...request,
						waitUntil: "networkidle",
						waitMs: params.waitMs ?? DEFAULT_WAIT_MS,
					},
					signal,
				);
				attempts.push({
					reason: "empty markdown stdout; retry with waitUntil=networkidle",
					command: [result.binary, ...result.args].join(" "),
					exitCode: result.code,
					stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
					stderrTail: result.stderr.split(/\r?\n/).slice(-20).join("\n"),
				});
			}

			if (result.code !== 0 && !result.stdout.trim()) {
				throw new Error(`Lightpanda fetch failed (exit ${result.code}).\n${result.stderr}`);
			}

			let body = result.stdout;
			if (!body.trim()) {
				body = [
					`[Lightpanda produced no ${dump} output for ${params.url}.]`,
					"The process exited successfully, but stdout was empty.",
					dump === "markdown"
						? "For JavaScript-rendered pages, try waitUntil=networkidle or dump=semantic_tree_text."
						: "Try increasing waitMs, using waitUntil=networkidle, or choosing another dump mode.",
				].join("\n");
			}
			if (attempts.length > 1 && result.stdout.trim()) {
				body = `[Initial markdown fetch produced no output; retried with waitUntil=networkidle.]\n\n${body}`;
			}
			if (result.code !== 0) {
				body = `[Lightpanda exited with code ${result.code}; stdout was still captured.]\nStderr tail:\n${result.stderr
					.split(/\r?\n/)
					.slice(-10)
					.join("\n")}\n\n${body}`;
			}

			return makeTextResult(body, {
				url: params.url,
				dump,
				exitCode: result.code,
				stderrTail: result.stderr.split(/\r?\n/).slice(-20).join("\n"),
				command: [result.binary, ...result.args].join(" "),
				attempts,
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_server",
		label: "Lightpanda CDP Server",
		description: "Start, stop, restart, or inspect a Lightpanda Chrome DevTools Protocol server.",
		promptSnippet: "Manage the Lightpanda CDP server used for browser debugging tools.",
		promptGuidelines: ["Use lightpanda_cdp_server status when CDP debugging tools fail or need connection details."],
		parameters: Type.Object({
			action: StringEnum(["start", "status", "stop", "restart"] as const),
			...cdpServerOptionSchema,
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "stop") {
				const stopped = await stopServer();
				ctx.ui.setStatus("lightpanda", undefined);
				return makeTextResult(stopped.stopped ? "Stopped managed Lightpanda CDP server." : (stopped.reason ?? "No managed Lightpanda server running."), stopped);
			}
			if (params.action === "restart") {
				await stopServer();
				const info = await ensureServer(params, signal);
				ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
				return makeTextResult(`Restarted Lightpanda CDP server.\n${serverStatusText(info.version)}`, info as any);
			}
			if (params.action === "start") {
				const info = await ensureServer(params, signal);
				ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
				return makeTextResult(`Started Lightpanda CDP server.\n${serverStatusText(info.version)}`, info as any);
			}

			const host = typeof params.host === "string" && params.host.trim() ? params.host.trim() : serverInfo?.host ?? DEFAULT_CDP_HOST;
			const port = parseInteger(params.port, serverInfo?.port ?? DEFAULT_CDP_PORT, 1, 65_535);
			const version = serverInfo ? await fetchJsonVersion(serverInfo.host, serverInfo.port) : await fetchJsonVersion(host, port);
			if (!serverInfo && version) {
				serverInfo = { host, port, wsEndpoint: version.webSocketDebuggerUrl ?? `ws://${host}:${port}/`, managed: false };
			}
			return makeTextResult(serverStatusText(version), {
				serverInfo,
				version,
				clientConnected: cdpClient?.isOpen ?? false,
				sessionId: cdpClient?.sessionId,
				targetId: cdpClient?.targetId,
				logs: lightpandaLogs.slice(-50),
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_navigate",
		label: "Lightpanda CDP Navigate",
		description: "Navigate the stateful Lightpanda CDP page to a URL and return title, URL, body preview, and recent CDP diagnostics.",
		promptSnippet: "Navigate a Lightpanda CDP page for debugging JavaScript-driven sites.",
		promptGuidelines: [
			"Use lightpanda_cdp_navigate before lightpanda_cdp_eval when debugging page JavaScript or runtime state.",
			"Use lightpanda_fetch instead of CDP navigation when you only need static page content.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to." }),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle", "done"] as const)),
			waitMs: Type.Optional(Type.Number({ description: "Maximum time to wait for the selected navigation event. Default: 5000." })),
			...cdpServerOptionSchema,
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { client, info } = await getClient(params, signal);
			ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
			const waitUntil = params.waitUntil ?? "load";
			const waitMs = parseInteger(params.waitMs, DEFAULT_WAIT_MS, 0, 60_000);
			const navigation = await client.navigate(params.url, waitUntil, waitMs);
			const summary = await client.pageSummary();
			const diagnostics = recentDiagnostics(client);

			const body = [
				`Navigated to: ${params.url}`,
				`Waited for: ${waitUntil}${navigation.waitedFor ? ` (${navigation.waitedFor.method})` : " (timeout/no matching event)"}`,
				`CDP endpoint: ${info.wsEndpoint}`,
				"",
				"Page summary:",
				formatJson(summary),
				"",
				"Recent diagnostics:",
				formatJson(diagnostics),
			].join("\n");

			return makeTextResult(body, {
				navigation,
				summary,
				diagnostics,
				server: info,
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_eval",
		label: "Lightpanda CDP Evaluate",
		description: "Evaluate JavaScript in the stateful Lightpanda CDP page. Optionally navigate first. Returns Runtime.evaluate result plus recent diagnostics.",
		promptSnippet: "Evaluate JavaScript in a Lightpanda CDP page for debugging DOM/runtime state.",
		promptGuidelines: [
			"Use lightpanda_cdp_eval to inspect DOM state, collect console-relevant data, or run debugging JavaScript on the current CDP page.",
			"When returning complex values from lightpanda_cdp_eval, prefer scripts that return JSON-serializable objects or JSON.stringify(...).",
		],
		parameters: Type.Object({
			script: Type.String({ description: "JavaScript expression to evaluate in the page. Return JSON-serializable values when possible." }),
			url: Type.Optional(Type.String({ description: "Optional URL to navigate to before evaluating." })),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle", "done"] as const)),
			waitMs: Type.Optional(Type.Number({ description: "Wait time when url is provided. Default: 5000." })),
			commandTimeoutMs: Type.Optional(Type.Number({ description: "CDP Runtime.evaluate timeout. Default: 15000." })),
			...cdpServerOptionSchema,
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { client, info } = await getClient(params, signal);
			ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
			let navigation: unknown;
			if (params.url) {
				navigation = await client.navigate(
					params.url,
					params.waitUntil ?? "load",
					parseInteger(params.waitMs, DEFAULT_WAIT_MS, 0, 60_000),
				);
			}
			const evaluation = await client.evaluate(
				params.script,
				parseInteger(params.commandTimeoutMs, DEFAULT_CDP_COMMAND_TIMEOUT_MS, 1_000, 120_000),
			);
			const diagnostics = recentDiagnostics(client);

			const body = [
				params.url ? `Navigated before evaluation: ${params.url}` : "Evaluated in current CDP page.",
				`CDP endpoint: ${info.wsEndpoint}`,
				"",
				"Evaluation result:",
				formatJson(evaluation),
				"",
				"Recent diagnostics:",
				formatJson(diagnostics),
			].join("\n");

			return makeTextResult(body, {
				navigation,
				evaluation,
				diagnostics,
				server: info,
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_command",
		label: "Lightpanda Raw CDP Command",
		description: "Send a raw Chrome DevTools Protocol command to Lightpanda. Params are supplied as a JSON object string for provider compatibility.",
		promptSnippet: "Send low-level CDP commands to the current Lightpanda browser/page session.",
		promptGuidelines: [
			"Use lightpanda_cdp_command for advanced debugging only when higher-level Lightpanda CDP tools are insufficient.",
		],
		parameters: Type.Object({
			method: Type.String({ description: "CDP method, e.g. Page.getFrameTree, Runtime.evaluate, Network.getResponseBody." }),
			paramsJson: Type.Optional(Type.String({ description: "JSON object string for CDP params. Omit for {}." })),
			session: Type.Optional(StringEnum(["auto", "page", "browser", "none"] as const)),
			commandTimeoutMs: Type.Optional(Type.Number({ description: "Command timeout. Default: 15000." })),
			...cdpServerOptionSchema,
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { client, info } = await getClient(params, signal);
			ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
			let commandParams: Record<string, unknown> = {};
			if (params.paramsJson?.trim()) {
				try {
					const parsed = JSON.parse(params.paramsJson);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("paramsJson must be a JSON object");
					commandParams = parsed;
				} catch (err) {
					throw new Error(`Invalid paramsJson: ${String(err)}`);
				}
			}

			const commandResult = await client.command(
				params.method,
				commandParams,
				params.session ?? "auto",
				parseInteger(params.commandTimeoutMs, DEFAULT_CDP_COMMAND_TIMEOUT_MS, 1_000, 120_000),
			);
			const diagnostics = recentDiagnostics(client);
			const body = [`CDP ${params.method} result:`, formatJson(commandResult), "", "Recent diagnostics:", formatJson(diagnostics)].join("\n");
			return makeTextResult(body, {
				method: params.method,
				params: commandParams,
				result: commandResult,
				diagnostics,
				server: info,
			});
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_events",
		label: "Lightpanda CDP Events",
		description: "Return recent Lightpanda CDP events and process logs collected by the extension.",
		promptSnippet: "Inspect recent Lightpanda CDP events and process logs for debugging.",
		promptGuidelines: ["Use lightpanda_cdp_events after navigation/evaluation if you need recent CDP events or Lightpanda stderr diagnostics."],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum events/log lines to return. Default: 50." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear stored CDP events and Lightpanda logs after reading." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const limit = parseInteger(params.limit, 50, 1, 300);
			const diagnostics = recentDiagnostics(cdpClient, limit);
			if (params.clear) {
				if (cdpClient) cdpClient.events = [];
				lightpandaLogs.length = 0;
			}
			return makeTextResult(formatJson(diagnostics), {
				...diagnostics,
				cleared: Boolean(params.clear),
			});
		},
	});

	pi.registerTool({
		name: "playwright_screenshot",
		label: "Playwright Screenshot",
		description: "Capture a real visual PNG screenshot with Playwright Chromium and save it to disk. Can optionally attach the image to the tool result.",
		promptSnippet: "Capture a real visual web page screenshot with Playwright Chromium.",
		promptGuidelines: [
			"Use playwright_screenshot when the user asks for an actual visual screenshot or page render.",
			"Use lightpanda_fetch for text/DOM extraction; use playwright_screenshot for visual rendering correctness.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to screenshot." }),
			path: Type.Optional(Type.String({ description: "Optional output PNG path, relative to current cwd unless absolute. Defaults to a temp file." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page instead of only the viewport. Default: false." })),
			includeImage: Type.Optional(Type.Boolean({ description: "Include base64 image content in the tool result. Default: false." })),
			viewportWidth: Type.Optional(Type.Number({ description: "Viewport width in CSS pixels. Default: 1280." })),
			viewportHeight: Type.Optional(Type.Number({ description: "Viewport height in CSS pixels. Default: 900." })),
			deviceScaleFactor: Type.Optional(Type.Number({ description: "Device scale factor. Default: 1." })),
			colorScheme: Type.Optional(StringEnum(["light", "dark", "no-preference"] as const)),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"] as const)),
			waitSelector: Type.Optional(Type.String({ description: "CSS selector to wait for before capture." })),
			waitScript: Type.Optional(Type.String({ description: "JavaScript expression to wait for before capture." })),
			waitMs: Type.Optional(Type.Number({ description: "Extra delay in milliseconds after navigation/waits before capture." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Navigation and wait timeout. Default: 30000." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			onUpdate?.({ content: [text(`Capturing ${params.url} with Playwright Chromium...`)], details: {} });
			const capture = await capturePlaywrightScreenshot(params, ctx.cwd, signal);
			const body = [
				"Captured real screenshot with Playwright Chromium.",
				`Saved PNG: ${capture.outputPath}`,
				`URL: ${params.url}`,
				capture.pageInfo?.url && capture.pageInfo.url !== params.url ? `Final URL: ${capture.pageInfo.url}` : undefined,
				capture.pageInfo?.title ? `Title: ${capture.pageInfo.title}` : undefined,
				`Viewport: ${capture.viewport.width}x${capture.viewport.height} @ ${capture.deviceScaleFactor}x`,
				`Full page: ${capture.fullPage}`,
				`PNG size: ${formatSize(capture.bytes)}`,
				`Elapsed: ${capture.elapsedMs}ms`,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: params.includeImage ? [text(body), image(capture.base64)] : [text(body)],
				details: {
					backend: "playwright-chromium",
					outputPath: capture.outputPath,
					bytes: capture.bytes,
					elapsedMs: capture.elapsedMs,
					viewport: capture.viewport,
					deviceScaleFactor: capture.deviceScaleFactor,
					fullPage: capture.fullPage,
					waitUntil: capture.waitUntil,
					pageInfo: capture.pageInfo,
				},
			};
		},
	});

	pi.registerTool({
		name: "lightpanda_cdp_screenshot",
		label: "Lightpanda CDP Screenshot",
		description: `${SCREENSHOT_WARNING} Calls Page.captureScreenshot and saves the returned PNG so this limitation is explicit.`,
		promptSnippet: "Call Lightpanda Page.captureScreenshot and save the returned placeholder PNG.",
		promptGuidelines: [
			"Do not use lightpanda_cdp_screenshot as evidence of visual rendering correctness; Lightpanda currently returns a placeholder screenshot.",
			"Use lightpanda_fetch or lightpanda_cdp_eval for actual page content/state; screenshots are placeholder-only in Lightpanda v1 nightly.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Optional URL to navigate to before capture." })),
			path: Type.Optional(Type.String({ description: "Optional output PNG path, relative to current cwd unless absolute. Defaults to a temp file." })),
			includeImage: Type.Optional(Type.Boolean({ description: "Include base64 image content in the tool result. Default: false." })),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle", "done"] as const)),
			waitMs: Type.Optional(Type.Number({ description: "Wait time when url is provided. Default: 5000." })),
			...cdpServerOptionSchema,
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const { client, info } = await getClient(params, signal);
			ctx.ui.setStatus("lightpanda", `LP ${info.port}`);
			let navigation: unknown;
			if (params.url) {
				navigation = await client.navigate(
					params.url,
					params.waitUntil ?? "load",
					parseInteger(params.waitMs, DEFAULT_WAIT_MS, 0, 60_000),
				);
			}
			const capture = (await client.command("Page.captureScreenshot", { format: "png" }, "page")) as { data: string };
			const outputPath = params.path
				? normalizePathArg(params.path, ctx.cwd)
				: join(await mkdtemp(join(tmpdir(), "pi-lightpanda-shot-")), "lightpanda-placeholder.png");
			await withFileMutationQueue(outputPath, async () => {
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(outputPath, Buffer.from(capture.data, "base64"));
			});

			const body = [
				SCREENSHOT_WARNING,
				`Saved PNG: ${outputPath}`,
				params.url ? `URL: ${params.url}` : undefined,
				`CDP endpoint: ${info.wsEndpoint}`,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: params.includeImage ? [text(body), image(capture.data)] : [text(body)],
				details: {
					placeholder: true,
					warning: SCREENSHOT_WARNING,
					outputPath,
					navigation,
					server: info,
				},
			};
		},
	});

	pi.on("session_shutdown", async () => {
		await stopServer();
	});
}
