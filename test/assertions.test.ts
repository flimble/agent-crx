import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkEvents, countErrors } from "../src/assertions.js";
import type { ExtEventWithoutSession } from "../src/events.js";

const ts = "2025-01-01T00:00:00.000Z";

const consoleError = (text: string): ExtEventWithoutSession => ({
  type: "console",
  ts,
  level: "error",
  label: null,
  text,
});

const consoleLog = (text: string): ExtEventWithoutSession => ({
  type: "console",
  ts,
  level: "log",
  label: null,
  text,
});

const exception = (text: string): ExtEventWithoutSession => ({
  type: "exception",
  ts,
  label: null,
  text,
});

const networkError = (error: string, url: string): ExtEventWithoutSession => ({
  type: "network_error",
  ts,
  label: null,
  error,
  resourceType: "XHR",
  url,
});

const response = (status: number, url: string): ExtEventWithoutSession => ({
  type: "response",
  ts,
  label: null,
  status,
  url,
});

describe("checkEvents", () => {
  it("returns no failures when no rules enabled", () => {
    const events = [consoleError("oops"), exception("crash")];
    assert.deepEqual(checkEvents(events, {}), []);
  });

  it("detects console errors", () => {
    const events = [consoleLog("ok"), consoleError("bad thing")];
    const failures = checkEvents(events, { noConsoleErrors: true });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].rule, "no-console-errors");
    assert.ok(failures[0].detail.includes("bad thing"));
  });

  it("ignores console logs when checking for errors", () => {
    const events = [consoleLog("fine"), consoleLog("also fine")];
    const failures = checkEvents(events, { noConsoleErrors: true });
    assert.equal(failures.length, 0);
  });

  it("detects exceptions", () => {
    const events = [exception("TypeError: x is not a function")];
    const failures = checkEvents(events, { noExceptions: true });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].rule, "no-exceptions");
  });

  it("detects network errors", () => {
    const events = [networkError("net::ERR_CONNECTION_REFUSED", "https://api.example.com")];
    const failures = checkEvents(events, { noNetworkErrors: true });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].rule, "no-network-errors");
    assert.ok(failures[0].detail.includes("ERR_CONNECTION_REFUSED"));
  });

  it("detects failed requests (4xx/5xx)", () => {
    const events = [
      response(200, "https://ok.com"),
      response(404, "https://missing.com"),
      response(500, "https://broken.com"),
    ];
    const failures = checkEvents(events, { noFailedRequests: true });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].rule, "no-failed-requests");
    assert.ok(failures[0].detail.includes("2 failed"));
  });

  it("passes when 2xx/3xx only", () => {
    const events = [response(200, "https://ok.com"), response(301, "https://redirect.com")];
    const failures = checkEvents(events, { noFailedRequests: true });
    assert.equal(failures.length, 0);
  });

  it("multiple rules catch multiple issues", () => {
    const events = [consoleError("err"), exception("crash"), networkError("timeout", "https://x.com")];
    const failures = checkEvents(events, {
      noConsoleErrors: true,
      noExceptions: true,
      noNetworkErrors: true,
    });
    assert.equal(failures.length, 3);
  });
});

describe("countErrors", () => {
  it("counts zero for clean events", () => {
    const events = [consoleLog("ok"), response(200, "https://ok.com")];
    assert.equal(countErrors(events), 0);
  });

  it("counts all error types", () => {
    const events = [
      consoleError("err"),
      exception("crash"),
      networkError("fail", "https://x.com"),
      response(500, "https://broken.com"),
      consoleLog("ok"),
      response(200, "https://fine.com"),
    ];
    assert.equal(countErrors(events), 4);
  });

  it("counts empty array as zero", () => {
    assert.equal(countErrors([]), 0);
  });
});
