import { connectToTab } from "./connection.js";

export interface WaitOptions {
  port: number;
  tabFilter?: string;
  selector?: string;
  title?: string;
  consoleMatch?: string;
  networkMatch?: string;
  timeout: number;
  json: boolean;
}

interface WaitResult {
  met: boolean;
  condition: string;
  elapsed: string;
  timeout?: boolean;
}

export const wait = async (opts: WaitOptions): Promise<void> => {
  const conditions = [opts.selector, opts.title, opts.consoleMatch, opts.networkMatch].filter(Boolean);
  if (conditions.length === 0) {
    console.error("Exactly one condition required: --selector, --title, --console, or --network");
    process.exit(1);
  }
  if (conditions.length > 1) {
    console.error("Only one condition allowed at a time");
    process.exit(1);
  }

  const { client } = await connectToTab(opts.port, opts.tabFilter);
  const start = Date.now();

  try {
    // Poll-based conditions (selector, title)
    if (opts.selector || opts.title) {
      const conditionName = opts.selector ? "selector" : "title";
      const expression = opts.selector
        ? `document.querySelector(${JSON.stringify(opts.selector)}) !== null`
        : `document.title.includes(${JSON.stringify(opts.title)})`;

      await client.Runtime.enable();

      const met = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), opts.timeout);
        const poll = async () => {
          const result = await client.Runtime.evaluate({
            expression,
            returnByValue: true,
          });
          if (result.result?.value === true) {
            clearTimeout(timer);
            resolve(true);
          } else {
            setTimeout(poll, 500);
          }
        };
        poll();
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const result: WaitResult = met
        ? { met: true, condition: conditionName, elapsed: `${elapsed}s` }
        : { met: false, condition: conditionName, elapsed: `${elapsed}s`, timeout: true };

      output(result, opts.json);
      process.exit(met ? 0 : 1);
    }

    // Event-based conditions (console, network)
    if (opts.consoleMatch) {
      await client.Runtime.enable();

      const met = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), opts.timeout);
        client.Runtime.consoleAPICalled(
          (params: { type: string; args: Array<{ value?: unknown; description?: string }> }) => {
            const text = params.args.map((a) => String(a.value ?? a.description ?? "")).join(" ");
            if (text.includes(opts.consoleMatch!)) {
              clearTimeout(timer);
              resolve(true);
            }
          }
        );
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const result: WaitResult = met
        ? { met: true, condition: "console", elapsed: `${elapsed}s` }
        : { met: false, condition: "console", elapsed: `${elapsed}s`, timeout: true };

      output(result, opts.json);
      process.exit(met ? 0 : 1);
    }

    if (opts.networkMatch) {
      await client.Network.enable({});

      const met = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), opts.timeout);
        client.Network.responseReceived(
          (params: { response: { url: string } }) => {
            if (params.response.url.includes(opts.networkMatch!)) {
              clearTimeout(timer);
              resolve(true);
            }
          }
        );
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const result: WaitResult = met
        ? { met: true, condition: "network", elapsed: `${elapsed}s` }
        : { met: false, condition: "network", elapsed: `${elapsed}s`, timeout: true };

      output(result, opts.json);
      process.exit(met ? 0 : 1);
    }
  } finally {
    await client.close();
  }
};

const output = (result: WaitResult, json: boolean): void => {
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.met) {
      console.log(`OK: ${result.condition} met in ${result.elapsed}`);
    } else {
      console.log(`TIMEOUT: ${result.condition} not met after ${result.elapsed}`);
    }
  }
};
