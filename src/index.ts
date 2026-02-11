#!/usr/bin/env node

import { program } from "commander";
import { loadConfig } from "./config.js";
import { isDaemonRunning, daemonRequest } from "./client.js";
import { startDaemon, stopDaemon, daemonStatus } from "./daemon.js";
import { takeScreenshot } from "./screenshot.js";
import {
  navigate,
  reload,
  evaluate,
  reloadExtension,
  listTabs,
  listExtensions,
  extensionErrors,
} from "./interact.js";
import { record } from "./record.js";
import { verify } from "./verify.js";
import { wait } from "./wait.js";
import { check } from "./check.js";
import { connectToTab } from "./connection.js";
import { formatSnapshot, type SnapshotResult, type SnapshotRef } from "./snapshot.js";
import { formatInspect, type InspectResult } from "./inspect.js";

program
  .name("agent-crx")
  .description("CDP inspector for Chrome extensions")
  .version("3.0.0");

interface BaseFlags {
  port: string;
  tab?: string;
  daemonPort: string;
}

const addBaseOptions = (cmd: ReturnType<typeof program.command>) =>
  cmd
    .option("-p, --port <number>", "Chrome debugging port", "9222")
    .option("-t, --tab <filter>", "Filter tabs by URL substring")
    .option("--daemon-port <number>", "Daemon HTTP port", "9300");

const resolveConfig = (opts: BaseFlags) =>
  loadConfig(process.cwd(), {
    port: parseInt(opts.port, 10),
    daemonPort: parseInt(opts.daemonPort, 10),
    tabFilter: opts.tab,
  });

const withErrorHandling = (fn: () => Promise<void>) =>
  fn().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });

// --- Daemon management ---

const daemonCmd = program.command("daemon").description("Manage the background daemon");

daemonCmd
  .command("start")
  .description("Start the background daemon")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("--daemon-port <number>", "Daemon HTTP port", "9300")
  .option("--foreground", "Run in foreground (don't detach)", false)
  .action(
    (opts: { port: string; tab?: string; daemonPort: string; foreground: boolean }) => {
      withErrorHandling(() =>
        startDaemon({
          port: parseInt(opts.port, 10),
          daemonPort: parseInt(opts.daemonPort, 10),
          tabFilter: opts.tab,
          foreground: opts.foreground,
          configCwd: process.cwd(),
        })
      );
    }
  );

daemonCmd
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    stopDaemon();
  });

daemonCmd
  .command("status")
  .description("Check if daemon is running")
  .action(() => {
    daemonStatus();
  });

// --- Status ---

addBaseOptions(
  program.command("status").description("Show connection status")
).action((opts: BaseFlags) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const status = await daemonRequest<{
        connected: boolean;
        tabUrl: string | null;
        tabTitle: string | null;
        uptime: number;
        bufferSize: number;
        eventCounts: { console: number; network: number; exception: number };
      }>(config.daemonPort, "GET", "/status");
      const upMin = Math.floor(status.uptime / 60);
      console.log(
        status.connected
          ? `Connected: ${status.tabUrl} (${status.bufferSize} events, ${upMin}m uptime)`
          : `Daemon running but disconnected (${upMin}m uptime)`
      );
    } else {
      // Fallback: try direct CDP
      const { client, target } = await connectToTab(config.port, config.tabFilter);
      console.log(`Direct: ${target.url}`);
      await client.close();
    }
  });
});

// --- Errors ---

addBaseOptions(
  program
    .command("errors")
    .description("Show console errors, exceptions, and failed requests")
    .option("--count", "Only show error count", false)
    .option("--json", "JSON output", false)
    .option("--last <n>", "Last N errors")
    .option("--minutes <n>", "Errors from last N minutes")
).action((opts: BaseFlags & { count: boolean; json: boolean; last?: string; minutes?: string }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      if (opts.count) {
        const summary = await daemonRequest<{ summary: string; total: number }>(
          config.daemonPort, "GET", "/errors/summary"
        );
        if (opts.json) {
          console.log(JSON.stringify(summary));
        } else {
          console.log(summary.summary);
        }
      } else {
        const params = new URLSearchParams();
        if (opts.last) params.set("last", opts.last);
        if (opts.minutes) params.set("minutes", opts.minutes);
        const qs = params.toString();
        const errors = await daemonRequest<unknown[]>(
          config.daemonPort, "GET", `/errors${qs ? `?${qs}` : ""}`
        );
        if (opts.json) {
          console.log(JSON.stringify(errors));
        } else if (errors.length === 0) {
          console.log("No errors");
        } else {
          for (const e of errors as Array<{ type: string; text?: string; error?: string; status?: number; url?: string; frequency?: string }>) {
            const msg = e.text ?? (e.error ? `${e.error}${e.url ? ` ${e.url}` : ""}` : null) ?? (e.status ? `${e.status} ${e.url}` : "unknown");
            const freq = e.frequency ? ` (${e.frequency})` : "";
            console.log(`[${e.type}] ${msg}${freq}`);
          }
        }
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Console ---

addBaseOptions(
  program
    .command("console")
    .description("Query console output from daemon buffer")
    .argument("[pattern]", "Filter by text pattern")
    .option("--last <n>", "Last N entries")
    .option("--minutes <n>", "Entries from last N minutes")
    .option("--source <source>", "Filter by source: page, extension")
    .option("--json", "JSON output", false)
).action((pattern: string | undefined, opts: BaseFlags & { last?: string; minutes?: string; source?: string; json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const params = new URLSearchParams();
      if (pattern) params.set("q", pattern);
      if (opts.last) params.set("last", opts.last);
      if (opts.minutes) params.set("minutes", opts.minutes);
      if (opts.source) params.set("source", opts.source);
      const qs = params.toString();
      const events = await daemonRequest<unknown[]>(
        config.daemonPort, "GET", `/console${qs ? `?${qs}` : ""}`
      );
      if (opts.json) {
        console.log(JSON.stringify(events));
      } else if (events.length === 0) {
        console.log("No console output");
      } else {
        for (const e of events as Array<{ type: string; level?: string; text: string }>) {
          const prefix = e.level && e.level !== "log" ? `[${e.level}] ` : "";
          console.log(`${prefix}${e.text}`);
        }
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Network ---

addBaseOptions(
  program
    .command("network")
    .description("Query network events from daemon buffer")
    .option("--failed", "Only failed requests (4xx, 5xx, errors)", false)
    .option("--last <n>", "Last N entries")
    .option("--minutes <n>", "Entries from last N minutes")
    .option("--json", "JSON output", false)
).action((opts: BaseFlags & { failed: boolean; last?: string; minutes?: string; json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const params = new URLSearchParams();
      if (opts.failed) params.set("status", "4xx,5xx");
      if (opts.last) params.set("last", opts.last);
      if (opts.minutes) params.set("minutes", opts.minutes);
      const qs = params.toString();
      const events = await daemonRequest<unknown[]>(
        config.daemonPort, "GET", `/network${qs ? `?${qs}` : ""}`
      );
      if (opts.json) {
        console.log(JSON.stringify(events));
      } else if (events.length === 0) {
        console.log("No network events");
      } else {
        for (const e of events as Array<{ type: string; method?: string; url?: string; status?: number; error?: string }>) {
          if (e.type === "request") {
            console.log(`${e.method} ${e.url}`);
          } else if (e.type === "response") {
            console.log(`${e.status} ${e.url}`);
          } else if (e.type === "network_error") {
            console.log(`ERR ${e.error}${e.url ? ` ${e.url}` : ""}`);
          }
        }
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Screenshot ---

program
  .command("screenshot")
  .description("Capture a screenshot, return file path")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("--daemon-port <number>", "Daemon HTTP port", "9300")
  .option("-s, --selector <css>", "CSS selector to capture")
  .option("-o, --output <file>", "Output file path")
  .action(
    (opts: BaseFlags & { selector?: string; output?: string }) => {
      const config = resolveConfig(opts);
      withErrorHandling(async () => {
        if (await isDaemonRunning(config.daemonPort)) {
          const params = new URLSearchParams();
          if (opts.selector) params.set("selector", opts.selector);
          if (opts.output) params.set("output", opts.output);
          const qs = params.toString();
          const result = await daemonRequest<{ path: string }>(
            config.daemonPort, "GET", `/screenshot${qs ? `?${qs}` : ""}`
          );
          console.log(result.path);
        } else {
          const path = await takeScreenshot({
            port: config.port,
            tabFilter: config.tabFilter,
            selector: opts.selector,
            output: opts.output,
          });
          console.log(path);
        }
      });
    }
  );

// --- Extensions ---

program
  .command("extensions")
  .description("List installed Chrome extensions")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("--daemon-port <number>", "Daemon HTTP port", "9300")
  .option("-v, --verbose", "Show detailed info", false)
  .option("--json", "JSON output", false)
  .action((opts: { port: string; daemonPort: string; verbose: boolean; json: boolean }) => {
    const config = loadConfig(process.cwd(), {
      port: parseInt(opts.port, 10),
      daemonPort: parseInt(opts.daemonPort, 10),
    });
    withErrorHandling(async () => {
      if (opts.json && await isDaemonRunning(config.daemonPort)) {
        const exts = await daemonRequest<unknown[]>(config.daemonPort, "GET", "/extensions");
        console.log(JSON.stringify(exts));
      } else {
        await listExtensions({ port: config.port, verbose: opts.verbose, json: opts.json });
      }
    });
  });

// --- Extension errors ---

program
  .command("ext-errors")
  .description("Show errors for a Chrome extension")
  .argument("<extension-id>", "Extension ID")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("--daemon-port <number>", "Daemon HTTP port", "9300")
  .option("--json", "JSON output", false)
  .action((extensionId: string, opts: { port: string; daemonPort: string; json: boolean }) => {
    const config = loadConfig(process.cwd(), {
      port: parseInt(opts.port, 10),
      daemonPort: parseInt(opts.daemonPort, 10),
    });
    withErrorHandling(async () => {
      if (await isDaemonRunning(config.daemonPort)) {
        const result = await daemonRequest<unknown>(
          config.daemonPort, "GET", `/extension/${extensionId}/errors`
        );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          const r = result as { name: string; version: string; errorCount: number; runtimeErrors: Array<{ message: string }>; manifestErrors: Array<{ message: string }> };
          console.log(`${r.name} v${r.version}`);
          if (r.errorCount === 0) {
            console.log("No errors.");
          } else {
            for (const e of r.runtimeErrors) console.log(`  ${e.message}`);
            for (const e of r.manifestErrors) console.log(`  [manifest] ${e.message}`);
          }
        }
      } else {
        await extensionErrors({ port: config.port, extensionId, json: opts.json });
      }
    });
  });

// --- Reload extension ---

program
  .command("reload")
  .description("Reload a Chrome extension by ID")
  .argument("<extension-id>", "Extension ID")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("--daemon-port <number>", "Daemon HTTP port", "9300")
  .option("--inspect", "Run full inspect after reload", false)
  .option("--json", "JSON output", false)
  .action((extensionId: string, opts: { port: string; daemonPort: string; inspect: boolean; json: boolean }) => {
    const config = loadConfig(process.cwd(), {
      port: parseInt(opts.port, 10),
      daemonPort: parseInt(opts.daemonPort, 10),
    });
    withErrorHandling(async () => {
      if (await isDaemonRunning(config.daemonPort)) {
        const qs = opts.inspect ? "?inspect=true" : "";
        const result = await daemonRequest<{
          name: string; version: string; errorCount: number;
          diff: { newErrors: string[]; resolvedErrors: string[]; unchanged: number };
          inspect?: InspectResult;
        }>(config.daemonPort, "POST", `/reload-ext/${extensionId}${qs}`);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          const errors = result.errorCount > 0 ? `, ${result.errorCount} error${result.errorCount > 1 ? "s" : ""}` : "";
          console.log(`Reloaded ${result.name} v${result.version}${errors}`);
          if (result.diff.newErrors.length > 0) {
            console.log(`  New: ${result.diff.newErrors.join(", ")}`);
          }
          if (result.diff.resolvedErrors.length > 0) {
            console.log(`  Resolved: ${result.diff.resolvedErrors.join(", ")}`);
          }
          if (opts.inspect && result.inspect) {
            console.log("");
            console.log(formatInspect(result.inspect));
          }
        }
      } else {
        await reloadExtension({ port: config.port, extensionId });
      }
    });
  });

// --- Reload page ---

addBaseOptions(
  program.command("reload-page").description("Reload the active tab")
    .option("--inspect", "Run full inspect after reload", false)
    .option("--json", "JSON output", false)
).action((opts: BaseFlags & { inspect: boolean; json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const qs = opts.inspect ? "?inspect=true" : "";
      const result = await daemonRequest<{ ok: boolean; url?: string; inspect?: InspectResult }>(
        config.daemonPort, "POST", `/reload-page${qs}`
      );
      if (opts.inspect && result.inspect) {
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Reloaded: ${result.url ?? "unknown"}\n`);
          console.log(formatInspect(result.inspect));
        }
      } else {
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Reloaded: ${result.url ?? "unknown"}`);
        }
      }
    } else {
      await reload({ port: config.port, tabFilter: config.tabFilter });
    }
  });
});

// --- Navigate ---

addBaseOptions(
  program
    .command("navigate")
    .description("Navigate the active tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--inspect", "Run full inspect after navigation", false)
    .option("--json", "JSON output", false)
).action((url: string, opts: BaseFlags & { inspect: boolean; json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const body = opts.inspect ? { url, inspect: true } : { url };
      const result = await daemonRequest<{ ok: boolean; url: string; inspect?: InspectResult }>(
        config.daemonPort, "POST", "/navigate", body
      );
      if (opts.inspect && result.inspect) {
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Navigated to ${result.url}\n`);
          console.log(formatInspect(result.inspect));
        }
      } else {
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Navigated to ${result.url}`);
        }
      }
    } else {
      await navigate({ port: config.port, tabFilter: config.tabFilter, url });
    }
  });
});

// --- Eval ---

addBaseOptions(
  program
    .command("eval")
    .description("Evaluate JavaScript in the page context")
    .argument("<expression>", "JavaScript expression")
    .option("--json", "JSON output", false)
).action((expression: string, opts: BaseFlags & { json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const result = await daemonRequest<{ value: unknown }>(
        config.daemonPort, "POST", "/eval", { expression }
      );
      if (opts.json) {
        console.log(JSON.stringify(result.value));
      } else if (result.value === undefined) {
        console.log("undefined");
      } else if (typeof result.value === "object") {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(String(result.value));
      }
    } else {
      await evaluate({ port: config.port, tabFilter: config.tabFilter, expression, json: opts.json });
    }
  });
});

// --- Health ---

addBaseOptions(
  program.command("health").description("Pass/fail health check")
).action((opts: BaseFlags) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    const reasons: string[] = [];

    if (await isDaemonRunning(config.daemonPort)) {
      // Check connection
      const status = await daemonRequest<{ connected: boolean }>(
        config.daemonPort, "GET", "/status"
      );
      if (!status.connected) reasons.push("tab disconnected");

      // Check page responsive
      if (status.connected) {
        try {
          const evalResult = await daemonRequest<{ value: unknown }>(
            config.daemonPort, "POST", "/eval", { expression: "document.readyState" }
          );
          if (evalResult.value !== "complete") reasons.push(`page not ready: ${evalResult.value}`);
        } catch {
          reasons.push("page unresponsive");
        }
      }

      // Check errors
      const summary = await daemonRequest<{ total: number }>(
        config.daemonPort, "GET", "/errors/summary"
      );
      if (summary.total > 0) reasons.push(`${summary.total} error${summary.total > 1 ? "s" : ""}`);
    } else {
      // Direct CDP fallback
      try {
        const { client, target } = await connectToTab(config.port, config.tabFilter);
        try {
          await client.Runtime.enable();
          const result = await client.Runtime.evaluate({
            expression: "document.readyState",
            returnByValue: true,
          });
          if (result.result?.value !== "complete") reasons.push(`page not ready: ${result.result?.value}`);
        } finally {
          await client.close();
        }
      } catch (err) {
        reasons.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (reasons.length === 0) {
      console.log("PASS");
      process.exit(0);
    } else {
      console.log(`FAIL: ${reasons.join(", ")}`);
      process.exit(1);
    }
  });
});

// --- Clear ---

addBaseOptions(
  program.command("clear").description("Clear the event buffer")
).action((opts: BaseFlags) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      await daemonRequest(config.daemonPort, "POST", "/clear");
      console.log("Buffer cleared");
    } else {
      console.log("Daemon not running, nothing to clear");
    }
  });
});

// --- Snapshot ---

addBaseOptions(
  program.command("snapshot").description("DOM snapshot with interactive element refs and watchlist")
    .option("--json", "JSON output", false)
).action((opts: BaseFlags & { json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const result = await daemonRequest<
        SnapshotResult & { extension?: { name: string; version: string; errorCount: number } }
      >(config.daemonPort, "GET", "/snapshot");
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(formatSnapshot(result, result.extension));
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Inspect ---

addBaseOptions(
  program.command("inspect").description("Full diagnostic: page state, errors, screenshot, DOM snapshot")
    .option("--json", "JSON output", false)
).action((opts: BaseFlags & { json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const result = await daemonRequest<InspectResult>(config.daemonPort, "GET", "/inspect");
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(formatInspect(result));
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Click ---

addBaseOptions(
  program.command("click").description("Click an element by @ref or CSS selector")
    .argument("<target>", "@ref number or CSS selector")
    .option("--json", "JSON output", false)
).action((target: string, opts: BaseFlags & { json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const body = target.startsWith("@")
        ? { ref: parseInt(target.slice(1), 10) }
        : { selector: target };
      const result = await daemonRequest<{ ok: boolean; tag: string; text: string; selector: string }>(
        config.daemonPort, "POST", "/click", body
      );
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Clicked <${result.tag}>${result.text ? ` "${result.text}"` : ""}`);
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Fill ---

addBaseOptions(
  program.command("fill").description("Fill an input by @ref or CSS selector")
    .argument("<target>", "@ref number or CSS selector")
    .argument("<value>", "Text to fill")
    .option("--json", "JSON output", false)
).action((target: string, value: string, opts: BaseFlags & { json: boolean }) => {
  const config = resolveConfig(opts);
  withErrorHandling(async () => {
    if (await isDaemonRunning(config.daemonPort)) {
      const body = target.startsWith("@")
        ? { ref: parseInt(target.slice(1), 10), value }
        : { selector: target, value };
      const result = await daemonRequest<{ ok: boolean; tag: string; name?: string; selector: string }>(
        config.daemonPort, "POST", "/fill", body
      );
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Filled <${result.tag}>${result.name ? ` [${result.name}]` : ""}`);
      }
    } else {
      console.error("Daemon not running. Start with: agent-crx daemon start");
      process.exit(1);
    }
  });
});

// --- Tabs (always direct CDP) ---

program
  .command("tabs")
  .description("List open browser tabs")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("--json", "JSON output", false)
  .action((opts: { port: string; json: boolean }) => {
    withErrorHandling(() => listTabs({ port: parseInt(opts.port, 10), json: opts.json }));
  });

// --- Verify ---

program
  .command("verify")
  .description("Verify a tab has no errors (binary pass/fail)")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("-d, --duration <ms>", "Event collection window in ms", "2000")
  .option("--no-console-errors", "Fail on console.error")
  .option("--no-exceptions", "Fail on uncaught exceptions")
  .option("--no-network-errors", "Fail on network failures")
  .option("--no-failed-requests", "Fail on 4xx/5xx responses")
  .option("--selector <css>", "Assert element exists")
  .option("--no-selector <css>", "Assert element absent")
  .option("--title <text>", "Assert title contains text")
  .option("--json", "JSON output", false)
  .action(
    (opts: {
      port: string;
      tab?: string;
      duration: string;
      consoleErrors: boolean;
      exceptions: boolean;
      networkErrors: boolean;
      failedRequests: boolean;
      selector?: string;
      noSelector?: string;
      title?: string;
      json: boolean;
    }) => {
      withErrorHandling(() =>
        verify({
          port: parseInt(opts.port, 10),
          tabFilter: opts.tab,
          duration: parseInt(opts.duration, 10),
          noConsoleErrors: opts.consoleErrors === false,
          noExceptions: opts.exceptions === false,
          noNetworkErrors: opts.networkErrors === false,
          noFailedRequests: opts.failedRequests === false,
          selector: opts.selector,
          noSelector: opts.noSelector,
          title: opts.title,
          json: opts.json,
        })
      );
    }
  );

// --- Wait ---

program
  .command("wait")
  .description("Block until a condition is met or timeout")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("--selector <css>", "Wait for element to exist")
  .option("--title <text>", "Wait for title to contain text")
  .option("--console <pattern>", "Wait for console message matching pattern")
  .option("--network <pattern>", "Wait for network response URL matching pattern")
  .option("--timeout <ms>", "Max wait time in ms", "30000")
  .option("--json", "JSON output", false)
  .action(
    (opts: {
      port: string;
      tab?: string;
      selector?: string;
      title?: string;
      console?: string;
      network?: string;
      timeout: string;
      json: boolean;
    }) => {
      withErrorHandling(() =>
        wait({
          port: parseInt(opts.port, 10),
          tabFilter: opts.tab,
          selector: opts.selector,
          title: opts.title,
          consoleMatch: opts.console,
          networkMatch: opts.network,
          timeout: parseInt(opts.timeout, 10),
          json: opts.json,
        })
      );
    }
  );

// --- Check ---

program
  .command("check")
  .description("Navigate, wait for ready, collect events, verify assertions")
  .argument("<url>", "URL to navigate to")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("--wait-for <css>", "Wait for selector after navigation")
  .option("--timeout <ms>", "Navigation + wait timeout in ms", "30000")
  .option("-d, --duration <ms>", "Event collection after ready in ms", "2000")
  .option("--no-console-errors", "Fail on console.error")
  .option("--no-exceptions", "Fail on uncaught exceptions")
  .option("--no-network-errors", "Fail on network failures")
  .option("--no-failed-requests", "Fail on 4xx/5xx responses")
  .option("--selector <css>", "Assert element exists")
  .option("--no-selector <css>", "Assert element absent")
  .option("--title <text>", "Assert title contains text")
  .option("--json", "JSON output", false)
  .action(
    (
      url: string,
      opts: {
        port: string;
        tab?: string;
        waitFor?: string;
        timeout: string;
        duration: string;
        consoleErrors: boolean;
        exceptions: boolean;
        networkErrors: boolean;
        failedRequests: boolean;
        selector?: string;
        noSelector?: string;
        title?: string;
        json: boolean;
      }
    ) => {
      withErrorHandling(() =>
        check({
          port: parseInt(opts.port, 10),
          tabFilter: opts.tab,
          url,
          waitFor: opts.waitFor,
          timeout: parseInt(opts.timeout, 10),
          duration: parseInt(opts.duration, 10),
          noConsoleErrors: opts.consoleErrors === false,
          noExceptions: opts.exceptions === false,
          noNetworkErrors: opts.networkErrors === false,
          noFailedRequests: opts.failedRequests === false,
          selector: opts.selector,
          noSelector: opts.noSelector,
          title: opts.title,
          json: opts.json,
        })
      );
    }
  );

// --- Record (always direct CDP) ---

program
  .command("record")
  .description("Record a screencast GIF of the active tab")
  .option("-p, --port <number>", "Chrome debugging port", "9222")
  .option("-t, --tab <filter>", "Filter tabs by URL substring")
  .option("-o, --output <file>", "Output filename")
  .option("-d, --duration <seconds>", "Max duration in seconds", "5")
  .option("--fps <number>", "Frames per second", "15")
  .option("--width <px>", "Max width in pixels", "800")
  .action(
    (opts: { port: string; tab?: string; output?: string; duration: string; fps: string; width: string }) => {
      const config = loadConfig(process.cwd(), {
        port: parseInt(opts.port, 10),
        tabFilter: opts.tab,
      });
      withErrorHandling(async () => {
        await record({
          port: config.port,
          tabFilter: config.tabFilter,
          output: opts.output,
          duration: parseInt(opts.duration, 10),
          fps: parseInt(opts.fps, 10),
          maxWidth: parseInt(opts.width, 10),
        });
      });
    }
  );

program.parse();
