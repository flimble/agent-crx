import CDP from "chrome-remote-interface";
import { connectToTab, type CDPTarget } from "./connection.js";

interface BaseOpts {
  port: number;
  tabFilter?: string;
}

// --- Shared helper: run a function on a temp chrome://extensions tab ---

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

// --- Extension info types ---

interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface RuntimeError {
  message: string;
  severity: string;
  source: string;
  contextUrl: string;
  occurrences: number;
  stackTrace: StackFrame[];
}

interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  type: string;
  location: string;
  incognitoAccess: boolean;
  errorCount: number;
  runtimeErrors: RuntimeError[];
  manifestErrors: Array<{ message: string }>;
  permissions: string[];
  hostPermissions: string[];
}

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
            type: e.type,
            location: e.location,
            incognitoAccess: e.incognitoAccess?.isEnabled || false,
            errorCount: (e.runtimeErrors?.length || 0) + (e.manifestErrors?.length || 0),
            runtimeErrors: (e.runtimeErrors || []).map(err => ({
              message: err.message,
              severity: err.severity,
              source: err.source,
              contextUrl: err.contextUrl || '',
              occurrences: err.occurrences || 1,
              stackTrace: (err.stackTrace || []).map(f => ({
                functionName: f.functionName,
                url: f.url,
                lineNumber: f.lineNumber,
                columnNumber: f.columnNumber,
              })),
            })),
            manifestErrors: (e.manifestErrors || []).map(err => ({
              message: err.message,
            })),
            permissions: (e.permissions?.simplePermissions || []).map(p => typeof p === 'string' ? p : p.message || ''),
            hostPermissions: (e.permissions?.runtimeHostPermissions?.hosts || []).map(h => h.host || ''),
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

const findExtension = async (port: number, extensionId: string): Promise<ExtensionInfo> => {
  const extensions = await queryExtensions(port);
  const ext = extensions.find((e) => e.id === extensionId);
  if (!ext) {
    const suggestions = extensions
      .filter((e) => e.name.toLowerCase().includes(extensionId.toLowerCase()) || e.id.startsWith(extensionId))
      .slice(0, 3);

    let msg = `Extension "${extensionId}" not found.`;
    if (suggestions.length > 0) {
      msg += "\nDid you mean:";
      for (const s of suggestions) {
        msg += `\n  ${s.id}  ${s.name}`;
      }
    }
    throw new Error(msg);
  }
  return ext;
};

// --- Page interaction commands ---

export const navigate = async (opts: BaseOpts & { url: string }): Promise<void> => {
  const { client } = await connectToTab(opts.port, opts.tabFilter);
  try {
    await client.Page.enable();
    await client.Page.navigate({ url: opts.url });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      client.on("Page.loadEventFired" as string, () => { clearTimeout(timer); resolve(); });
    });
    console.log(`Navigated to ${opts.url}`);
  } finally {
    await client.close();
  }
};

export const reload = async (opts: BaseOpts): Promise<void> => {
  const { client, target } = await connectToTab(opts.port, opts.tabFilter);
  try {
    await client.Page.enable();
    await client.Page.reload({ ignoreCache: true });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      client.on("Page.loadEventFired" as string, () => { clearTimeout(timer); resolve(); });
    });
    console.log(`Reloaded: ${target.url}`);
  } finally {
    await client.close();
  }
};

export const click = async (opts: BaseOpts & { selector: string }): Promise<void> => {
  const { client } = await connectToTab(opts.port, opts.tabFilter);
  try {
    await client.Runtime.enable();
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(opts.selector)});
        if (!el) return { error: 'Element not found: ${opts.selector.replace(/'/g, "\\'")}' };
        el.click();
        return { ok: true, tag: el.tagName, text: el.textContent?.slice(0, 50) };
      })()`,
      returnByValue: true,
    });
    const val = result.result?.value as Record<string, unknown> | undefined;
    if (val?.error) {
      console.error(String(val.error));
      process.exit(1);
    }
    console.log(`Clicked <${String(val?.tag).toLowerCase()}>${val?.text ? ` "${val.text}"` : ""}`);
  } finally {
    await client.close();
  }
};

export const evaluate = async (opts: BaseOpts & { expression: string; json?: boolean }): Promise<void> => {
  const { client } = await connectToTab(opts.port, opts.tabFilter);
  try {
    await client.Runtime.enable();
    const result = await client.Runtime.evaluate({
      expression: opts.expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "Unknown error";
      if (opts.json) {
        console.log(JSON.stringify({ error: errMsg }));
      } else {
        console.error(`Error: ${errMsg}`);
      }
      process.exit(1);
    }
    const val = result.result?.value;
    if (opts.json) {
      console.log(JSON.stringify(val));
    } else if (val === undefined) {
      console.log("undefined");
    } else if (typeof val === "object") {
      console.log(JSON.stringify(val, null, 2));
    } else {
      console.log(String(val));
    }
  } finally {
    await client.close();
  }
};

// --- Extension commands ---

export const reloadExtension = async (opts: { port: number; extensionId: string }): Promise<void> => {
  // Single withExtensionsPage call: query -> validate -> reload -> query again
  await withExtensionsPage(opts.port, async (client) => {
    // Query extensions to validate the ID exists
    const queryExpr = `new Promise((resolve, reject) => {
      if (!chrome.developerPrivate) { reject(new Error('chrome.developerPrivate not available')); return; }
      chrome.developerPrivate.getExtensionsInfo({}, (extensions) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(extensions.map(e => ({
          id: e.id, name: e.name, version: e.version,
          enabled: e.state === 'ENABLED',
          errorCount: (e.runtimeErrors?.length || 0) + (e.manifestErrors?.length || 0),
        })));
      });
    })`;

    const beforeResult = await client.Runtime.evaluate({
      expression: queryExpr, returnByValue: true, awaitPromise: true,
    });
    if (beforeResult.exceptionDetails) {
      throw new Error(`Failed to query extensions: ${beforeResult.exceptionDetails.exception?.description ?? beforeResult.exceptionDetails.text}`);
    }

    const extensions = (beforeResult.result?.value as Array<{ id: string; name: string; version: string; enabled: boolean; errorCount: number }>) ?? [];
    const before = extensions.find((e) => e.id === opts.extensionId);
    if (!before) {
      const suggestions = extensions
        .filter((e) => e.name.toLowerCase().includes(opts.extensionId.toLowerCase()) || e.id.startsWith(opts.extensionId))
        .slice(0, 3);
      let msg = `Extension "${opts.extensionId}" not found.`;
      if (suggestions.length > 0) {
        msg += "\nDid you mean:";
        for (const s of suggestions) msg += `\n  ${s.id}  ${s.name}`;
      }
      throw new Error(msg);
    }

    console.log(`Reloading ${before.name} v${before.version}...`);

    // Reload
    const reloadResult = await client.Runtime.evaluate({
      expression: `new Promise((resolve, reject) => {
        chrome.developerPrivate.reload('${opts.extensionId}', {failQuietly: true}, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve('ok');
        });
      })`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reloadResult.exceptionDetails) {
      throw new Error(`Reload failed: ${reloadResult.exceptionDetails.exception?.description ?? reloadResult.exceptionDetails.text}`);
    }

    // Brief wait for extension to settle
    await new Promise((r) => setTimeout(r, 500));

    // Query again for post-reload state
    const afterResult = await client.Runtime.evaluate({
      expression: queryExpr, returnByValue: true, awaitPromise: true,
    });

    const afterExts = (afterResult.result?.value as Array<{ id: string; name: string; version: string; enabled: boolean; errorCount: number }>) ?? [];
    const after = afterExts.find((e) => e.id === opts.extensionId) ?? before;

    const versionChanged = before.version !== after.version;
    const status = after.enabled ? "enabled" : "disabled";
    const errors = after.errorCount > 0 ? `, ${after.errorCount} error${after.errorCount > 1 ? "s" : ""}` : "";

    console.log(
      `Reloaded ${after.name} v${after.version}${versionChanged ? ` (was v${before.version})` : ""} [${status}${errors}]`
    );
  });
};

export const listTabs = async (opts: { port: number; json?: boolean }): Promise<void> => {
  const targets: CDPTarget[] = await CDP.List({ port: opts.port });
  const pages = targets.filter((t) => t.type === "page");

  if (opts.json) {
    console.log(JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, url: p.url }))));
    return;
  }

  if (pages.length === 0) {
    console.log("No open tabs.");
    return;
  }

  const maxTitle = Math.min(
    50,
    Math.max(...pages.map((p) => p.title.length))
  );

  for (const page of pages) {
    const title = page.title.slice(0, 50).padEnd(maxTitle);
    console.log(`${title}  ${page.url}`);
  }
};

export const listExtensions = async (opts: { port: number; verbose?: boolean; json?: boolean }): Promise<void> => {
  const extensions = await queryExtensions(opts.port);

  if (opts.json) {
    console.log(JSON.stringify(extensions));
    return;
  }

  if (extensions.length === 0) {
    console.log("No extensions installed.");
    return;
  }

  if (opts.verbose) {
    for (const ext of extensions) {
      const status = ext.enabled ? "ENABLED" : "DISABLED";
      console.log(`${ext.name} (${ext.id})`);
      console.log(`  Version:    ${ext.version}`);
      console.log(`  Status:     ${status}`);
      console.log(`  Type:       ${ext.type}`);
      console.log(`  Location:   ${ext.location}`);
      console.log(`  Incognito:  ${ext.incognitoAccess ? "allowed" : "not allowed"}`);
      if (ext.permissions.length > 0) {
        console.log(`  Permissions: ${ext.permissions.join(", ")}`);
      }
      if (ext.hostPermissions.length > 0) {
        console.log(`  Hosts:      ${ext.hostPermissions.join(", ")}`);
      }
      if (ext.errorCount > 0) {
        console.log(`  Errors:     ${ext.errorCount}`);
      }
      console.log("");
    }
  } else {
    const maxName = Math.min(
      40,
      Math.max(...extensions.map((e) => e.name.length))
    );

    for (const ext of extensions) {
      const name = ext.name.slice(0, 40).padEnd(maxName);
      const status = ext.enabled ? "ON " : "OFF";
      const errors = ext.errorCount > 0 ? `  [${ext.errorCount} err]` : "";
      console.log(`${ext.id}  ${status}  ${name}  v${ext.version}${errors}`);
    }
  }
};

export const extensionErrors = async (opts: { port: number; extensionId: string; json?: boolean }): Promise<void> => {
  const ext = await findExtension(opts.port, opts.extensionId);

  if (opts.json) {
    console.log(JSON.stringify({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      errorCount: ext.errorCount,
      manifestErrors: ext.manifestErrors,
      runtimeErrors: ext.runtimeErrors,
    }));
    return;
  }

  console.log(`${ext.name} v${ext.version} (${ext.id})`);

  if (ext.manifestErrors.length === 0 && ext.runtimeErrors.length === 0) {
    console.log("No errors.");
    return;
  }

  if (ext.manifestErrors.length > 0) {
    console.log(`\nManifest errors (${ext.manifestErrors.length}):`);
    for (const err of ext.manifestErrors) {
      console.log(`  ${err.message}`);
    }
  }

  if (ext.runtimeErrors.length > 0) {
    console.log(`\nRuntime errors (${ext.runtimeErrors.length}):`);
    for (const err of ext.runtimeErrors) {
      const frame = err.stackTrace[0];
      const loc = frame ? `${frame.url.replace(/.*\//, "")}:${frame.lineNumber}:${frame.columnNumber}` : "";
      const count = err.occurrences > 1 ? ` (x${err.occurrences})` : "";
      console.log(`  ${err.message}${count}`);
      if (loc) console.log(`    at ${loc}`);
    }
  }
};
