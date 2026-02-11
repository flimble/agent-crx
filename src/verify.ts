import { connectToTab } from "./connection.js";
import { now } from "./events.js";
import type { ExtEventWithoutSession } from "./events.js";
import { checkEvents, checkDom, countErrors, type AssertionRules, type DomChecks, type Failure } from "./assertions.js";

export interface VerifyOptions {
  port: number;
  tabFilter?: string;
  duration: number;
  noConsoleErrors: boolean;
  noExceptions: boolean;
  noNetworkErrors: boolean;
  noFailedRequests: boolean;
  selector?: string;
  noSelector?: string;
  title?: string;
  json: boolean;
}

interface VerifyResult {
  pass: boolean;
  failures: Failure[];
  summary: { events: number; errors: number; duration: string };
}

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

type CDPClient = Awaited<ReturnType<typeof import("chrome-remote-interface")>>;

const attachCollectors = async (client: CDPClient): Promise<{ events: ExtEventWithoutSession[] }> => {
  const events: ExtEventWithoutSession[] = [];

  await client.Runtime.enable();
  client.Runtime.consoleAPICalled(
    (params: { type: string; args: ConsoleArg[] }) => {
      const text = serializeArgs(params.args);
      const level = (params.type === "warning" ? "warn" : params.type) as
        "log" | "info" | "warn" | "error" | "debug";
      events.push({ type: "console", ts: now(), level, label: null, text });
    }
  );
  client.Runtime.exceptionThrown(
    (params: { exceptionDetails: { text: string; exception?: { description?: string } } }) => {
      const text = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text ?? "Unknown exception";
      events.push({ type: "exception", ts: now(), label: null, text });
    }
  );

  await client.Network.enable({});
  const requestUrls = new Map<string, string>();
  client.Network.requestWillBeSent(
    (params: { requestId: string; request: { method: string; url: string } }) => {
      requestUrls.set(params.requestId, params.request.url);
      events.push({ type: "request", ts: now(), label: null, method: params.request.method, url: params.request.url });
    }
  );
  client.Network.responseReceived(
    (params: { requestId: string; response: { status: number; url: string } }) => {
      requestUrls.delete(params.requestId);
      events.push({ type: "response", ts: now(), label: null, status: params.response.status, url: params.response.url });
    }
  );
  client.Network.loadingFailed(
    (params: { requestId: string; errorText: string; type: string }) => {
      const url = requestUrls.get(params.requestId) ?? "";
      requestUrls.delete(params.requestId);
      events.push({ type: "network_error", ts: now(), label: null, error: params.errorText, resourceType: params.type, url });
    }
  );

  return { events };
};

const hasAnyRule = (opts: VerifyOptions): boolean =>
  opts.noConsoleErrors || opts.noExceptions || opts.noNetworkErrors || opts.noFailedRequests;

export const verify = async (opts: VerifyOptions): Promise<void> => {
  const { client } = await connectToTab(opts.port, opts.tabFilter);

  try {
    const { events } = await attachCollectors(client);

    await new Promise((resolve) => setTimeout(resolve, opts.duration));

    const useDefaults = !hasAnyRule(opts);
    const rules: AssertionRules = {
      noConsoleErrors: opts.noConsoleErrors || useDefaults,
      noExceptions: opts.noExceptions || useDefaults,
      noNetworkErrors: opts.noNetworkErrors || useDefaults,
      noFailedRequests: opts.noFailedRequests || useDefaults,
    };

    const domChecks: DomChecks = {
      selector: opts.selector,
      noSelector: opts.noSelector,
      title: opts.title,
    };

    const eventFailures = checkEvents(events, rules);
    const domFailures = await checkDom(client, domChecks);
    const failures = [...eventFailures, ...domFailures];

    const errorCount = countErrors(events);

    const result: VerifyResult = {
      pass: failures.length === 0,
      failures,
      summary: {
        events: events.length,
        errors: errorCount,
        duration: `${(opts.duration / 1000).toFixed(1)}s`,
      },
    };

    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      if (result.pass) {
        console.log(`PASS (${result.summary.events} events, ${result.summary.duration})`);
      } else {
        console.log(`FAIL (${failures.length} failure${failures.length > 1 ? "s" : ""})`);
        for (const f of failures) {
          console.log(`  [${f.rule}] ${f.detail}`);
        }
      }
    }

    process.exit(result.pass ? 0 : 1);
  } finally {
    await client.close();
  }
};
