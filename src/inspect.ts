import type { SnapshotResult, SnapshotRef } from "./snapshot.js";

export interface InspectResult {
  url: string;
  title: string;
  readyState: string;
  extension?: { name: string; version: string; errorCount: number };
  errors: {
    console: number;
    exceptions: number;
    failedRequests: number;
  };
  recentErrors: Array<{ type: string; text?: string; error?: string; status?: number; url?: string }>;
  screenshotPath?: string;
  watchlist: Array<{ label: string; selector: string; found: boolean }>;
  interactiveElements: SnapshotRef[];
}

export const formatInspect = (result: InspectResult): string => {
  const lines: string[] = [];
  lines.push(`URL: ${result.url}`);
  lines.push(`Title: ${result.title}`);

  if (result.extension) {
    const errors = result.extension.errorCount > 0
      ? `, ${result.extension.errorCount} error${result.extension.errorCount > 1 ? "s" : ""}`
      : "";
    lines.push(`Extension: ${result.extension.name} v${result.extension.version} (loaded${errors})`);
  }

  const totalErrors = result.errors.console + result.errors.exceptions + result.errors.failedRequests;
  lines.push(`Errors: ${result.errors.console} console, ${result.errors.exceptions} exceptions, ${result.errors.failedRequests} failed requests`);

  if (result.recentErrors.length > 0) {
    lines.push("");
    lines.push("Recent errors:");
    for (const e of result.recentErrors) {
      const msg = e.text ?? (e.error ? `${e.error}${e.url ? ` ${e.url}` : ""}` : null) ?? (e.status ? `${e.status} ${e.url}` : "unknown");
      lines.push(`  [${e.type}] ${msg}`);
    }
  }

  if (result.screenshotPath) {
    lines.push(`Screenshot: ${result.screenshotPath}`);
  }

  if (result.watchlist.length > 0) {
    lines.push("");
    lines.push("DOM watchlist:");
    for (const w of result.watchlist) {
      const status = w.found ? "OK" : "MISSING";
      lines.push(`  [${status}] ${w.label}: ${w.selector}`);
    }
  }

  if (result.interactiveElements.length > 0) {
    lines.push("");
    lines.push(`Interactive elements (${result.interactiveElements.length}):`);
    for (const el of result.interactiveElements) {
      const parts: string[] = [el.tag];
      if (el.role) parts[0] = el.role;
      if (el.type && el.tag === "input") parts.push(`[${el.type}]`);
      if (el.disabled) parts.push("(disabled)");
      if (el.text) parts.push(`"${el.text}"`);
      else if (el.href) parts.push(el.href.length > 60 ? el.href.slice(0, 57) + "..." : el.href);
      lines.push(`  @${el.ref} ${parts.join(" ")}`);
    }
  }

  return lines.join("\n");
};
