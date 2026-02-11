import type { ConsoleEvent, ExceptionEvent, NetworkErrorEvent, NetworkResponseEvent, ExtEventWithoutSession } from "./events.js";

export interface Failure {
  rule: string;
  detail: string;
}

export interface AssertionRules {
  noConsoleErrors?: boolean;
  noExceptions?: boolean;
  noNetworkErrors?: boolean;
  noFailedRequests?: boolean;
}

export interface DomChecks {
  selector?: string;
  noSelector?: string;
  title?: string;
}

type ConsoleEventNoSession = Omit<ConsoleEvent, "session">;
type ExceptionEventNoSession = Omit<ExceptionEvent, "session">;
type NetworkErrorEventNoSession = Omit<NetworkErrorEvent, "session">;
type ResponseEventNoSession = Omit<NetworkResponseEvent, "session">;

export const checkEvents = (events: ExtEventWithoutSession[], rules: AssertionRules): Failure[] => {
  const failures: Failure[] = [];

  if (rules.noConsoleErrors) {
    const errs = events.filter(
      (e): e is ConsoleEventNoSession => e.type === "console" && e.level === "error"
    );
    if (errs.length > 0) {
      failures.push({
        rule: "no-console-errors",
        detail: `${errs.length} console error${errs.length > 1 ? "s" : ""}. Sample: ${errs[0].text.slice(0, 200)}`,
      });
    }
  }

  if (rules.noExceptions) {
    const excs = events.filter(
      (e): e is ExceptionEventNoSession => e.type === "exception"
    );
    if (excs.length > 0) {
      failures.push({
        rule: "no-exceptions",
        detail: `${excs.length} exception${excs.length > 1 ? "s" : ""}. Sample: ${excs[0].text.slice(0, 200)}`,
      });
    }
  }

  if (rules.noNetworkErrors) {
    const errs = events.filter(
      (e): e is NetworkErrorEventNoSession => e.type === "network_error"
    );
    if (errs.length > 0) {
      failures.push({
        rule: "no-network-errors",
        detail: `${errs.length} network error${errs.length > 1 ? "s" : ""}. Sample: ${errs[0].error}${errs[0].url ? ` ${errs[0].url}` : ""} (${errs[0].resourceType})`.slice(0, 200),
      });
    }
  }

  if (rules.noFailedRequests) {
    const failed = events.filter(
      (e): e is ResponseEventNoSession => e.type === "response" && e.status >= 400
    );
    if (failed.length > 0) {
      failures.push({
        rule: "no-failed-requests",
        detail: `${failed.length} failed request${failed.length > 1 ? "s" : ""}. Sample: ${failed[0].status} ${failed[0].url}`.slice(0, 200),
      });
    }
  }

  return failures;
};

export const countErrors = (events: ExtEventWithoutSession[]): number =>
  events.filter(
    (e) =>
      e.type === "exception" ||
      e.type === "network_error" ||
      (e.type === "console" && e.level === "error") ||
      (e.type === "response" && e.status >= 400)
  ).length;

type CDPClient = Awaited<ReturnType<typeof import("chrome-remote-interface")>>;

export const checkDom = async (client: CDPClient, checks: DomChecks): Promise<Failure[]> => {
  const failures: Failure[] = [];

  if (checks.selector) {
    const result = await client.Runtime.evaluate({
      expression: `document.querySelector(${JSON.stringify(checks.selector)}) !== null`,
      returnByValue: true,
    });
    if (result.result?.value !== true) {
      failures.push({
        rule: "selector-exists",
        detail: `Selector "${checks.selector}" not found`,
      });
    }
  }

  if (checks.noSelector) {
    const result = await client.Runtime.evaluate({
      expression: `document.querySelector(${JSON.stringify(checks.noSelector)}) === null`,
      returnByValue: true,
    });
    if (result.result?.value !== true) {
      failures.push({
        rule: "selector-absent",
        detail: `Selector "${checks.noSelector}" should not exist but was found`,
      });
    }
  }

  if (checks.title) {
    const result = await client.Runtime.evaluate({
      expression: `document.title`,
      returnByValue: true,
    });
    const actual = String(result.result?.value ?? "");
    if (!actual.includes(checks.title)) {
      failures.push({
        rule: "title-contains",
        detail: `Title "${actual}" does not contain "${checks.title}"`,
      });
    }
  }

  return failures;
};
