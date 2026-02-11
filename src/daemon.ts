import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync, openSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import CDP from "chrome-remote-interface";
import { findTargetTab, type CDPTarget } from "./connection.js";
import { now } from "./events.js";
import type { ExtEventWithoutSession } from "./events.js";
import { buildSnapshotExpression, formatSnapshot, type SnapshotResult, type SnapshotRef } from "./snapshot.js";
import { formatInspect, type InspectResult } from "./inspect.js";
import { buildClickExpression, buildFillExpression } from "./click.js";
import { loadConfig } from "./config.js";

// --- Paths ---

const BASE_DIR = join(homedir(), ".agent-crx");
const PID_FILE = join(BASE_DIR, "daemon.pid");
const LOG_FILE = join(BASE_DIR, "daemon.log");
const SCREENSHOTS_DIR = join(BASE_DIR, "screenshots");

const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

// --- Ring Buffer ---

export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  query(filter?: (item: T) => boolean, limit?: number): T[] {
    const result: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const item = this.items[(start + i) % this.capacity]!;
      if (!filter || filter(item)) {
        result.push(item);
      }
    }
    if (limit && limit > 0) {
      return result.slice(-limit);
    }
    return result;
  }

  clear(): void {
    this.items = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}

// --- Buffered Event ---

export type BufferedEvent = ExtEventWithoutSession & {
  source: "page" | "extension" | "unknown";
};

// --- Console arg serialization (from old collect.ts) ---

interface ConsoleArg {
  type: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: Array<{ name: string; value: string }> };
}

const serializeArgs = (args: ConsoleArg[]): string =>
  args
    .map((arg) => {
      if (arg.type === "string") return arg.value as string;
      if (arg.type === "number" || arg.type === "boolean") return String(arg.value);
      if (arg.type === "undefined") return "undefined";
      if (arg.type === "object" && arg.preview?.properties) {
        const props = arg.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
        return `{ ${props} }`;
      }
      return arg.description ?? String(arg.value ?? arg.type);
    })
    .join(" ");

// --- Extension info query (reused from interact.ts pattern) ---

interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  errorCount: number;
  runtimeErrors: Array<{ message: string; occurrences: number }>;
  manifestErrors: Array<{ message: string }>;
}

type CDPClientType = Awaited<ReturnType<typeof CDP>>;

const cdpConnect = async (target: string, port: number, retries = 3): Promise<CDPClientType> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await CDP({ target, port });
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw new Error("CDP connection failed");
};

const withExtensionsPage = async <T>(
  port: number,
  fn: (client: CDPClientType) => Promise<T>
): Promise<T> => {
  const targets: CDPTarget[] = await CDP.List({ port });
  const anyPage = targets.find((t) => t.type === "page");
  if (!anyPage) throw new Error("No open tabs to connect through");

  const client = await cdpConnect(anyPage.webSocketDebuggerUrl, port);
  try {
    const { targetId } = await client.Target.createTarget({ url: "chrome://extensions" });
    const tempClient = await cdpConnect(targetId, port);

    try {
      await tempClient.Page.enable();
      await tempClient.Runtime.enable();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        tempClient.on("Page.loadEventFired" as string, () => { clearTimeout(timer); resolve(); });
      });

      return await fn(tempClient);
    } finally {
      await tempClient.close();
      await client.Target.closeTarget({ targetId });
    }
  } finally {
    await client.close();
  }
};

const queryExtensions = async (port: number): Promise<ExtensionInfo[]> => {
  return withExtensionsPage(port, async (client) => {
    const result = await client.Runtime.evaluate({
      expression: `new Promise((resolve, reject) => {
        if (!chrome.developerPrivate) {
          reject(new Error('chrome.developerPrivate not available'));
          return;
        }
        chrome.developerPrivate.getExtensionsInfo({}, (extensions) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(extensions.map(e => ({
            id: e.id,
            name: e.name,
            version: e.version,
            enabled: e.state === 'ENABLED',
            errorCount: (e.runtimeErrors?.length || 0) + (e.manifestErrors?.length || 0),
            runtimeErrors: (e.runtimeErrors || []).map(err => ({
              message: err.message,
              occurrences: err.occurrences || 1,
            })),
            manifestErrors: (e.manifestErrors || []).map(err => ({
              message: err.message,
            })),
          })));
        });
      })`,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Failed to query extensions: ${result.exceptionDetails.text}`);
    }

    return (result.result?.value as ExtensionInfo[]) ?? [];
  });
};

// --- Source detection ---

const detectSource = (stackTrace?: { callFrames?: Array<{ url: string }> }): BufferedEvent["source"] => {
  if (!stackTrace?.callFrames) return "unknown";
  for (const frame of stackTrace.callFrames) {
    if (frame.url.includes("chrome-extension://")) return "extension";
  }
  return "page";
};

// --- Daemon State ---

interface DaemonState {
  port: number;
  daemonPort: number;
  tabFilter?: string;
  buffer: RingBuffer<BufferedEvent>;
  client: CDPClientType | null;
  target: CDPTarget | null;
  startTime: number;
  connected: boolean;
  reconnecting: boolean;
  eventCounts: { console: number; network: number; exception: number };
  refMap: Map<number, SnapshotRef>;
  configCwd: string;
}

// --- CDP Lifecycle ---

const connectCDP = async (state: DaemonState): Promise<void> => {
  const target = await findTargetTab(state.port, state.tabFilter);
  if (!target) throw new Error("No matching tab");

  const client = await CDP({ target: target.webSocketDebuggerUrl, port: state.port });

  state.client = client;
  state.target = target;
  state.connected = true;
  state.reconnecting = false;

  await client.Runtime.enable();
  await client.Network.enable({});

  // Track request URLs by ID for correlation with loadingFailed
  const requestUrls = new Map<string, string>();

  // Console events
  client.Runtime.consoleAPICalled(
    (params: { type: string; args: ConsoleArg[]; stackTrace?: { callFrames?: Array<{ url: string }> } }) => {
      const text = serializeArgs(params.args);
      const level = (params.type === "warning" ? "warn" : params.type) as
        "log" | "info" | "warn" | "error" | "debug";
      const source = detectSource(params.stackTrace);
      state.buffer.push({ type: "console", ts: now(), level, label: null, text, source });
      state.eventCounts.console++;
    }
  );

  // Exceptions
  client.Runtime.exceptionThrown(
    (params: {
      exceptionDetails: {
        text: string;
        exception?: { description?: string };
        stackTrace?: { callFrames?: Array<{ url: string }> };
      };
    }) => {
      const text =
        params.exceptionDetails.exception?.description ??
        params.exceptionDetails.text ??
        "Unknown exception";
      const source = detectSource(params.exceptionDetails.stackTrace);
      state.buffer.push({ type: "exception", ts: now(), label: null, text, source });
      state.eventCounts.exception++;
    }
  );

  // Network requests
  client.Network.requestWillBeSent(
    (params: { requestId: string; request: { method: string; url: string } }) => {
      requestUrls.set(params.requestId, params.request.url);
      state.buffer.push({
        type: "request",
        ts: now(),
        label: null,
        method: params.request.method,
        url: params.request.url,
        source: "unknown",
      });
      state.eventCounts.network++;
    }
  );

  // Network responses
  client.Network.responseReceived(
    (params: { requestId: string; response: { status: number; url: string } }) => {
      requestUrls.delete(params.requestId);
      state.buffer.push({
        type: "response",
        ts: now(),
        label: null,
        status: params.response.status,
        url: params.response.url,
        source: "unknown",
      });
      state.eventCounts.network++;
    }
  );

  // Network failures
  client.Network.loadingFailed(
    (params: { requestId: string; errorText: string; type: string }) => {
      const url = requestUrls.get(params.requestId) ?? "";
      requestUrls.delete(params.requestId);
      state.buffer.push({
        type: "network_error",
        ts: now(),
        label: null,
        error: params.errorText,
        resourceType: params.type,
        url,
        source: "unknown",
      });
      state.eventCounts.network++;
    }
  );

  // Handle disconnect
  client.on("disconnect", () => {
    state.connected = false;
    state.client = null;
    state.target = null;
    scheduleReconnect(state);
  });
};

const scheduleReconnect = (state: DaemonState): void => {
  if (state.reconnecting) return;
  state.reconnecting = true;

  let delay = 1000;
  const maxDelay = 10_000;

  const attempt = async () => {
    try {
      await connectCDP(state);
    } catch {
      delay = Math.min(delay * 2, maxDelay);
      setTimeout(attempt, delay);
    }
  };

  setTimeout(attempt, delay);
};

// --- HTTP Router ---

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

const addRoute = (method: string, path: string, handler: RouteHandler): void => {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_match, name) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "(\\?.*)?$"
  );
  routes.push({ method, pattern, paramNames, handler });
};

const matchRoute = (method: string, url: string): { handler: RouteHandler; params: Record<string, string> } | null => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = url.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { handler: route.handler, params };
    }
  }
  return null;
};

const parseQuery = (url: string): URLSearchParams => {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });

const json = (res: ServerResponse, data: unknown, status = 200): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const minutesFilter = (minutes: number): ((e: BufferedEvent) => boolean) => {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return (e: BufferedEvent) => e.ts >= cutoff;
};

// --- Frequency detection ---

const addFrequency = (events: BufferedEvent[]): Array<BufferedEvent & { frequency?: string }> => {
  const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
  const recentErrors = events.filter(
    (e) => e.ts >= thirtySecsAgo && (e.type === "console" && e.level === "error" || e.type === "exception")
  );

  // Count by message text
  const counts = new Map<string, number>();
  for (const e of recentErrors) {
    const key = "text" in e ? e.text : "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return events.map((e) => {
    const key = "text" in e ? (e as { text: string }).text : "";
    const count = counts.get(key);
    if (count && count >= 3) {
      return { ...e, frequency: `repeated ${count}x in 30s` };
    }
    return e;
  });
};

// --- Screenshot ---

const takeScreenshotDaemon = async (state: DaemonState, selector?: string, output?: string): Promise<string> => {
  if (!state.client || !state.connected) throw new Error("Not connected");

  const { Page, Runtime, DOM } = state.client;
  await Page.enable();

  let screenshotParams: Record<string, unknown> = { format: "png" };

  if (selector) {
    await DOM.enable();
    await Runtime.enable();

    const result = await Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });

    const bounds = result.result?.value as Record<string, number> | null;
    if (bounds) {
      screenshotParams = {
        format: "png",
        clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 },
      };
    }
  }

  const { data } = await Page.captureScreenshot(screenshotParams);

  if (output) {
    const filepath = resolve(output);
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, Buffer.from(data, "base64"));
    return filepath;
  }

  ensureDir(SCREENSHOTS_DIR);

  // Auto-cleanup old screenshots
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of readdirSync(SCREENSHOTS_DIR)) {
      const path = join(SCREENSHOTS_DIR, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }

  const filename = `shot-${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, Buffer.from(data, "base64"));

  return filepath;
};

// --- Register endpoints ---

const registerEndpoints = (state: DaemonState): void => {
  // GET /status
  addRoute("GET", "/status", async (_req, res) => {
    json(res, {
      connected: state.connected,
      tabUrl: state.target?.url ?? null,
      tabTitle: state.target?.title ?? null,
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      bufferSize: state.buffer.size,
      eventCounts: state.eventCounts,
      cdpPort: state.port,
    });
  });

  // GET /errors
  addRoute("GET", "/errors", async (req, res) => {
    const q = parseQuery(req.url ?? "");
    const last = q.get("last") ? parseInt(q.get("last")!, 10) : undefined;
    const minutes = q.get("minutes") ? parseInt(q.get("minutes")!, 10) : undefined;
    const source = q.get("source") as BufferedEvent["source"] | null;

    let filter = (e: BufferedEvent) =>
      e.type === "exception" ||
      e.type === "network_error" ||
      (e.type === "console" && e.level === "error") ||
      (e.type === "response" && e.status >= 400);

    if (minutes) {
      const timeFilter = minutesFilter(minutes);
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && timeFilter(e);
    }

    if (source) {
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && e.source === source;
    }

    const events = state.buffer.query(filter, last);
    json(res, addFrequency(events));
  });

  // GET /errors/summary
  addRoute("GET", "/errors/summary", async (_req, res) => {
    const errors = state.buffer.query((e) =>
      e.type === "exception" ||
      e.type === "network_error" ||
      (e.type === "console" && e.level === "error") ||
      (e.type === "response" && e.status >= 400)
    );

    const consoleErrors = errors.filter((e) => e.type === "console" && e.level === "error").length;
    const exceptions = errors.filter((e) => e.type === "exception").length;
    const failedRequests = errors.filter((e) => (e.type === "response" && e.status >= 400) || e.type === "network_error").length;

    const parts: string[] = [];
    if (consoleErrors > 0) parts.push(`${consoleErrors} error${consoleErrors > 1 ? "s" : ""}`);
    if (exceptions > 0) parts.push(`${exceptions} exception${exceptions > 1 ? "s" : ""}`);
    if (failedRequests > 0) parts.push(`${failedRequests} failed request${failedRequests > 1 ? "s" : ""}`);

    json(res, { summary: parts.length > 0 ? parts.join(", ") : "no errors", total: errors.length });
  });

  // GET /console
  addRoute("GET", "/console", async (req, res) => {
    const q = parseQuery(req.url ?? "");
    const pattern = q.get("q");
    const last = q.get("last") ? parseInt(q.get("last")!, 10) : undefined;
    const minutes = q.get("minutes") ? parseInt(q.get("minutes")!, 10) : undefined;
    const source = q.get("source") as BufferedEvent["source"] | null;

    let filter = (e: BufferedEvent): boolean => e.type === "console" || e.type === "exception";

    if (pattern) {
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && "text" in e && (e as { text: string }).text.includes(pattern);
    }

    if (minutes) {
      const timeFilter = minutesFilter(minutes);
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && timeFilter(e);
    }

    if (source) {
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && e.source === source;
    }

    json(res, state.buffer.query(filter, last));
  });

  // GET /network
  addRoute("GET", "/network", async (req, res) => {
    const q = parseQuery(req.url ?? "");
    const status = q.get("status");
    const last = q.get("last") ? parseInt(q.get("last")!, 10) : undefined;
    const minutes = q.get("minutes") ? parseInt(q.get("minutes")!, 10) : undefined;

    let filter = (e: BufferedEvent): boolean =>
      e.type === "request" || e.type === "response" || e.type === "network_error";

    if (status) {
      const ranges = status.split(",").map((s) => s.trim());
      const baseFilter = filter;
      filter = (e) => {
        if (!baseFilter(e)) return false;
        if (e.type === "network_error") return true;
        if (e.type === "response") {
          return ranges.some((r) => {
            if (r.endsWith("xx")) {
              const prefix = parseInt(r[0], 10);
              return Math.floor(e.status / 100) === prefix;
            }
            return e.status === parseInt(r, 10);
          });
        }
        return false;
      };
    }

    if (minutes) {
      const timeFilter = minutesFilter(minutes);
      const baseFilter = filter;
      filter = (e) => baseFilter(e) && timeFilter(e);
    }

    json(res, state.buffer.query(filter, last));
  });

  // GET /screenshot
  addRoute("GET", "/screenshot", async (req, res) => {
    try {
      const q = parseQuery(req.url ?? "");
      const selector = q.get("selector") ?? undefined;
      const output = q.get("output") ?? undefined;
      const path = await takeScreenshotDaemon(state, selector, output);
      json(res, { path });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /extensions
  addRoute("GET", "/extensions", async (_req, res) => {
    try {
      const exts = await queryExtensions(state.port);
      json(res, exts);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /extension/:id/errors
  addRoute("GET", "/extension/:id/errors", async (_req, res, params) => {
    try {
      const exts = await queryExtensions(state.port);
      const ext = exts.find((e) => e.id === params.id);
      if (!ext) {
        json(res, { error: `Extension ${params.id} not found` }, 404);
        return;
      }
      json(res, {
        id: ext.id,
        name: ext.name,
        version: ext.version,
        errorCount: ext.errorCount,
        runtimeErrors: ext.runtimeErrors,
        manifestErrors: ext.manifestErrors,
      });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /reload-ext/:id
  addRoute("POST", "/reload-ext/:id", async (req, res, params) => {
    try {
      const q = parseQuery(req.url ?? "");
      const withInspect = q.get("inspect") === "true";
      // Single withExtensionsPage call: query -> reload -> query
      const result = await withExtensionsPage(state.port, async (client) => {
        const queryExpr = `new Promise((resolve, reject) => {
          if (!chrome.developerPrivate) { reject(new Error('chrome.developerPrivate not available')); return; }
          chrome.developerPrivate.getExtensionsInfo({}, (extensions) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            resolve(extensions.map(e => ({
              id: e.id, name: e.name, version: e.version,
              enabled: e.state === 'ENABLED',
              errorCount: (e.runtimeErrors?.length || 0) + (e.manifestErrors?.length || 0),
              runtimeErrors: (e.runtimeErrors || []).map(err => ({ message: err.message, occurrences: err.occurrences || 1 })),
              manifestErrors: (e.manifestErrors || []).map(err => ({ message: err.message })),
            })));
          });
        })`;

        // Query before
        const beforeResult = await client.Runtime.evaluate({
          expression: queryExpr, returnByValue: true, awaitPromise: true,
        });
        if (beforeResult.exceptionDetails) {
          throw new Error(beforeResult.exceptionDetails.exception?.description ?? beforeResult.exceptionDetails.text);
        }

        const exts = (beforeResult.result?.value as ExtensionInfo[]) ?? [];
        const extBefore = exts.find((e) => e.id === params.id);
        if (!extBefore) return { notFound: true as const };

        const beforeErrors = new Set(extBefore.runtimeErrors.map((e) => e.message));

        // Reload
        const reloadResult = await client.Runtime.evaluate({
          expression: `new Promise((resolve, reject) => {
            chrome.developerPrivate.reload('${params.id}', {failQuietly: true}, () => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve('ok');
            });
          })`,
          returnByValue: true,
          awaitPromise: true,
        });
        if (reloadResult.exceptionDetails) {
          throw new Error(reloadResult.exceptionDetails.exception?.description ?? reloadResult.exceptionDetails.text);
        }

        // Brief wait for errors to settle
        await new Promise((r) => setTimeout(r, 500));

        // Query after
        const afterResult = await client.Runtime.evaluate({
          expression: queryExpr, returnByValue: true, awaitPromise: true,
        });
        const afterExts = (afterResult.result?.value as ExtensionInfo[]) ?? [];
        const extAfter = afterExts.find((e) => e.id === params.id);

        const afterErrors = new Set(extAfter?.runtimeErrors.map((e) => e.message) ?? []);
        const newErrors = [...afterErrors].filter((e) => !beforeErrors.has(e));
        const resolvedErrors = [...beforeErrors].filter((e) => !afterErrors.has(e));
        const unchanged = [...afterErrors].filter((e) => beforeErrors.has(e)).length;

        return {
          notFound: false as const,
          name: extAfter?.name ?? extBefore.name,
          version: extAfter?.version ?? extBefore.version,
          errorCount: extAfter?.errorCount ?? 0,
          diff: { newErrors, resolvedErrors, unchanged },
        };
      });

      if (result.notFound) {
        json(res, { error: `Extension ${params.id} not found` }, 404);
        return;
      }

      if (withInspect) {
        const inspect = await runInspect();
        json(res, { ...result, inspect });
      } else {
        json(res, result);
      }
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Helper: query current page URL via Runtime.evaluate
  const getCurrentUrl = async (): Promise<string | null> => {
    if (!state.client || !state.connected) return null;
    try {
      const result = await state.client.Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      return (result.result?.value as string) ?? null;
    } catch {
      return null;
    }
  };

  // Helper: run inspect and return result
  const runInspect = async (): Promise<InspectResult | null> => {
    try {
      if (!state.client || !state.connected) return null;
      const config = loadConfig(state.configCwd);
      const expr = buildSnapshotExpression(config.dom.selectors);
      await state.client.Runtime.enable();
      const snapResult = await state.client.Runtime.evaluate({
        expression: expr, returnByValue: true, awaitPromise: false,
      });
      if (snapResult.exceptionDetails) return null;
      const snapshot = snapResult.result?.value as SnapshotResult;

      state.refMap.clear();
      for (const el of snapshot.interactiveElements) {
        state.refMap.set(el.ref, el);
      }

      let extInfo: { name: string; version: string; errorCount: number } | undefined;
      if (config.extensionId) {
        try {
          const exts = await queryExtensions(state.port);
          const ext = exts.find((e) => e.id === config.extensionId);
          if (ext) extInfo = { name: ext.name, version: ext.version, errorCount: ext.errorCount };
        } catch { /* skip */ }
      }

      const allErrors = state.buffer.query((e) =>
        e.type === "exception" || e.type === "network_error" ||
        (e.type === "console" && e.level === "error") ||
        (e.type === "response" && e.status >= 400)
      );

      let screenshotPath: string | undefined;
      try { screenshotPath = await takeScreenshotDaemon(state); } catch { /* skip */ }

      return {
        url: snapshot.url,
        title: snapshot.title,
        readyState: snapshot.readyState,
        extension: extInfo,
        errors: {
          console: allErrors.filter((e) => e.type === "console" && e.level === "error").length,
          exceptions: allErrors.filter((e) => e.type === "exception").length,
          failedRequests: allErrors.filter((e) => (e.type === "response" && e.status >= 400) || e.type === "network_error").length,
        },
        recentErrors: allErrors.slice(-5).map((e) => {
          if (e.type === "console" || e.type === "exception") return { type: e.type, text: (e as { text: string }).text };
          if (e.type === "response") return { type: e.type, status: e.status, url: e.url };
          if (e.type === "network_error") return { type: e.type, error: e.error, url: e.url };
          return { type: e.type };
        }),
        screenshotPath,
        watchlist: snapshot.watchlist,
        interactiveElements: snapshot.interactiveElements,
      };
    } catch {
      return null;
    }
  };

  // POST /reload-page
  addRoute("POST", "/reload-page", async (req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const q = parseQuery(req.url ?? "");
      const withInspect = q.get("inspect") === "true";

      await state.client.Page.enable();
      await state.client.Page.reload({ ignoreCache: true });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        state.client!.on("Page.loadEventFired" as string, () => { clearTimeout(timer); resolve(); });
      });
      const url = await getCurrentUrl() ?? state.target?.url;
      if (state.target && url) state.target.url = url;

      if (withInspect) {
        const inspect = await runInspect();
        json(res, { ok: true, url, inspect });
      } else {
        json(res, { ok: true, url });
      }
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /navigate
  addRoute("POST", "/navigate", async (req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const body = JSON.parse(await readBody(req));
      if (!body.url) {
        json(res, { error: "url required" }, 400);
        return;
      }
      const withInspect = body.inspect === true;

      await state.client.Page.enable();
      await state.client.Page.navigate({ url: body.url });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        state.client!.on("Page.loadEventFired" as string, () => { clearTimeout(timer); resolve(); });
      });
      const url = await getCurrentUrl() ?? body.url;
      if (state.target) state.target.url = url;

      if (withInspect) {
        const inspect = await runInspect();
        json(res, { ok: true, url, inspect });
      } else {
        json(res, { ok: true, url });
      }
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /eval
  addRoute("POST", "/eval", async (req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const body = JSON.parse(await readBody(req));
      if (!body.expression) {
        json(res, { error: "expression required" }, 400);
        return;
      }
      await state.client.Runtime.enable();
      const result = await state.client.Runtime.evaluate({
        expression: body.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? "Unknown error";
        json(res, { error: errMsg }, 400);
        return;
      }
      json(res, { value: result.result?.value });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /clear
  addRoute("POST", "/clear", async (_req, res) => {
    state.buffer.clear();
    state.eventCounts = { console: 0, network: 0, exception: 0 };
    json(res, { ok: true });
  });

  // GET /snapshot
  addRoute("GET", "/snapshot", async (_req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const config = loadConfig(state.configCwd);
      const expr = buildSnapshotExpression(config.dom.selectors);
      await state.client.Runtime.enable();
      const result = await state.client.Runtime.evaluate({
        expression: expr,
        returnByValue: true,
        awaitPromise: false,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Snapshot failed");
      }
      const snapshot = result.result?.value as SnapshotResult;

      state.refMap.clear();
      for (const el of snapshot.interactiveElements) {
        state.refMap.set(el.ref, el);
      }

      let extInfo: { name: string; version: string; errorCount: number } | undefined;
      if (config.extensionId) {
        try {
          const exts = await queryExtensions(state.port);
          const ext = exts.find((e) => e.id === config.extensionId);
          if (ext) {
            extInfo = { name: ext.name, version: ext.version, errorCount: ext.errorCount };
          }
        } catch { /* skip extension info if unavailable */ }
      }

      json(res, { ...snapshot, extension: extInfo });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /inspect
  addRoute("GET", "/inspect", async (_req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const config = loadConfig(state.configCwd);

      // Snapshot
      const expr = buildSnapshotExpression(config.dom.selectors);
      await state.client.Runtime.enable();
      const snapResult = await state.client.Runtime.evaluate({
        expression: expr,
        returnByValue: true,
        awaitPromise: false,
      });
      if (snapResult.exceptionDetails) {
        throw new Error(snapResult.exceptionDetails.exception?.description ?? snapResult.exceptionDetails.text ?? "Snapshot failed");
      }
      const snapshot = snapResult.result?.value as SnapshotResult;

      state.refMap.clear();
      for (const el of snapshot.interactiveElements) {
        state.refMap.set(el.ref, el);
      }

      // Extension info
      let extInfo: { name: string; version: string; errorCount: number } | undefined;
      if (config.extensionId) {
        try {
          const exts = await queryExtensions(state.port);
          const ext = exts.find((e) => e.id === config.extensionId);
          if (ext) {
            extInfo = { name: ext.name, version: ext.version, errorCount: ext.errorCount };
          }
        } catch { /* skip */ }
      }

      // Error counts from buffer
      const allErrors = state.buffer.query((e) =>
        e.type === "exception" ||
        e.type === "network_error" ||
        (e.type === "console" && e.level === "error") ||
        (e.type === "response" && e.status >= 400)
      );
      const consoleErrors = allErrors.filter((e) => e.type === "console" && e.level === "error").length;
      const exceptions = allErrors.filter((e) => e.type === "exception").length;
      const failedRequests = allErrors.filter((e) => (e.type === "response" && e.status >= 400) || e.type === "network_error").length;

      // Recent errors (last 5)
      const recentErrors = allErrors.slice(-5).map((e) => {
        if (e.type === "console" || e.type === "exception") {
          return { type: e.type, text: (e as { text: string }).text };
        }
        if (e.type === "response") {
          return { type: e.type, status: e.status, url: e.url };
        }
        if (e.type === "network_error") {
          return { type: e.type, error: e.error, url: e.url };
        }
        return { type: e.type };
      });

      // Screenshot
      let screenshotPath: string | undefined;
      try {
        screenshotPath = await takeScreenshotDaemon(state);
      } catch { /* skip */ }

      const inspectResult: InspectResult = {
        url: snapshot.url,
        title: snapshot.title,
        readyState: snapshot.readyState,
        extension: extInfo,
        errors: { console: consoleErrors, exceptions, failedRequests },
        recentErrors,
        screenshotPath,
        watchlist: snapshot.watchlist,
        interactiveElements: snapshot.interactiveElements,
      };

      json(res, inspectResult);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /click
  addRoute("POST", "/click", async (req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const body = JSON.parse(await readBody(req));
      let selector: string;

      if (body.ref !== undefined) {
        const refEntry = state.refMap.get(Number(body.ref));
        if (!refEntry) {
          json(res, { error: `Ref @${body.ref} not found. Run snapshot first.` }, 400);
          return;
        }
        selector = refEntry.selector;
      } else if (body.selector) {
        selector = body.selector;
      } else {
        json(res, { error: "ref or selector required" }, 400);
        return;
      }

      await state.client.Runtime.enable();
      const result = await state.client.Runtime.evaluate({
        expression: buildClickExpression(selector),
        returnByValue: true,
      });
      const val = result.result?.value as Record<string, unknown> | undefined;
      if (val?.error) {
        json(res, { error: String(val.error) }, 400);
        return;
      }
      json(res, { ok: true, tag: val?.tag, text: val?.text, selector });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /fill
  addRoute("POST", "/fill", async (req, res) => {
    try {
      if (!state.client || !state.connected) throw new Error("Not connected");
      const body = JSON.parse(await readBody(req));
      let selector: string;

      if (body.ref !== undefined) {
        const refEntry = state.refMap.get(Number(body.ref));
        if (!refEntry) {
          json(res, { error: `Ref @${body.ref} not found. Run snapshot first.` }, 400);
          return;
        }
        selector = refEntry.selector;
      } else if (body.selector) {
        selector = body.selector;
      } else {
        json(res, { error: "ref or selector required" }, 400);
        return;
      }

      if (body.value === undefined) {
        json(res, { error: "value required" }, 400);
        return;
      }

      await state.client.Runtime.enable();
      const result = await state.client.Runtime.evaluate({
        expression: buildFillExpression(selector, String(body.value)),
        returnByValue: true,
      });
      const val = result.result?.value as Record<string, unknown> | undefined;
      if (val?.error) {
        json(res, { error: String(val.error) }, 400);
        return;
      }
      json(res, { ok: true, tag: val?.tag, name: val?.name, selector });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
};

// --- PID Management ---

const readPid = (): number | null => {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const writePid = (): void => {
  ensureDir(BASE_DIR);
  writeFileSync(PID_FILE, String(process.pid));
};

const removePid = (): void => {
  try {
    unlinkSync(PID_FILE);
  } catch { /* ok */ }
};

// --- Public API ---

export interface DaemonOptions {
  port: number;
  daemonPort: number;
  tabFilter?: string;
  foreground?: boolean;
  configCwd?: string;
}

export const startDaemon = async (opts: DaemonOptions): Promise<void> => {
  if (!opts.foreground) {
    // Check for existing daemon (only from parent process, not the spawned child)
    const existingPid = readPid();
    if (existingPid && isProcessRunning(existingPid)) {
      console.log(`Daemon already running (PID ${existingPid})`);
      process.exit(1);
    }
    // Fork detached child
    ensureDir(BASE_DIR);
    const logFd = openSync(LOG_FILE, "a");
    const child = spawn(process.argv[0], [...process.argv.slice(1), "--foreground"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    // Write the child PID (not ours)
    ensureDir(BASE_DIR);
    writeFileSync(PID_FILE, String(child.pid));
    console.log(`Daemon started (PID ${child.pid})`);
    return;
  }

  // Running in foreground (either --foreground flag or detached child)
  writePid();

  const state: DaemonState = {
    port: opts.port,
    daemonPort: opts.daemonPort,
    tabFilter: opts.tabFilter,
    buffer: new RingBuffer(10_000),
    client: null,
    target: null,
    startTime: Date.now(),
    connected: false,
    reconnecting: false,
    eventCounts: { console: 0, network: 0, exception: 0 },
    refMap: new Map(),
    configCwd: opts.configCwd ?? process.cwd(),
  };

  registerEndpoints(state);

  // Connect to Chrome
  try {
    await connectCDP(state);
  } catch {
    // Will reconnect in background
    scheduleReconnect(state);
  }

  // Start HTTP server
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    const match = matchRoute(method, url);
    if (!match) {
      json(res, { error: "not found" }, 404);
      return;
    }

    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  server.listen(opts.daemonPort, "127.0.0.1", () => {
    // silence
  });

  // Cleanup on shutdown
  const cleanup = () => {
    removePid();
    if (state.client) {
      try { state.client.close(); } catch { /* ok */ }
    }
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
};

export const stopDaemon = (): void => {
  const pid = readPid();
  if (!pid) {
    console.log("No daemon running");
    return;
  }

  if (!isProcessRunning(pid)) {
    removePid();
    console.log("Daemon was not running (stale PID file cleaned)");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
  removePid();
};

export const daemonStatus = (): void => {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    console.log("Daemon is not running");
    process.exit(1);
  }
  console.log(`Daemon running (PID ${pid})`);
};
