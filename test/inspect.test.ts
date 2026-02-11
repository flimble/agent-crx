import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatInspect } from "../src/inspect.js";
import type { InspectResult } from "../src/inspect.js";

const baseResult: InspectResult = {
  url: "https://example.com",
  title: "Example Page",
  readyState: "complete",
  errors: { console: 0, exceptions: 0, failedRequests: 0 },
  recentErrors: [],
  watchlist: [],
  interactiveElements: [],
};

describe("formatInspect", () => {
  it("formats clean page", () => {
    const output = formatInspect(baseResult);
    assert.ok(output.includes("URL: https://example.com"));
    assert.ok(output.includes("Title: Example Page"));
    assert.ok(output.includes("Errors: 0 console, 0 exceptions, 0 failed requests"));
  });

  it("includes extension info", () => {
    const output = formatInspect({
      ...baseResult,
      extension: { name: "TestExt", version: "2.0.0", errorCount: 3 },
    });
    assert.ok(output.includes("Extension: TestExt v2.0.0 (loaded, 3 errors)"));
  });

  it("includes screenshot path", () => {
    const output = formatInspect({
      ...baseResult,
      screenshotPath: "/tmp/screenshot.png",
    });
    assert.ok(output.includes("Screenshot: /tmp/screenshot.png"));
  });

  it("formats recent errors", () => {
    const output = formatInspect({
      ...baseResult,
      errors: { console: 1, exceptions: 1, failedRequests: 0 },
      recentErrors: [
        { type: "console", text: "Something broke" },
        { type: "exception", text: "TypeError: null is not an object" },
      ],
    });
    assert.ok(output.includes("Recent errors:"));
    assert.ok(output.includes("[console] Something broke"));
    assert.ok(output.includes("[exception] TypeError"));
  });

  it("formats error with status and url", () => {
    const output = formatInspect({
      ...baseResult,
      errors: { console: 0, exceptions: 0, failedRequests: 1 },
      recentErrors: [
        { type: "response", status: 404, url: "https://api.example.com/data" },
      ],
    });
    assert.ok(output.includes("404 https://api.example.com/data"));
  });

  it("formats watchlist", () => {
    const output = formatInspect({
      ...baseResult,
      watchlist: [
        { label: "header", selector: "#header", found: true },
        { label: "modal", selector: ".modal", found: false },
      ],
    });
    assert.ok(output.includes("[OK] header: #header"));
    assert.ok(output.includes("[MISSING] modal: .modal"));
  });

  it("formats interactive elements", () => {
    const output = formatInspect({
      ...baseResult,
      interactiveElements: [
        { ref: 1, tag: "button", text: "Submit", selector: "#submit" },
        { ref: 2, tag: "input", type: "text", text: "", selector: "#name", name: "name" },
      ],
    });
    assert.ok(output.includes('@1 button "Submit"'));
    assert.ok(output.includes("@2 input [text]"));
  });

  it("shows disabled elements", () => {
    const output = formatInspect({
      ...baseResult,
      interactiveElements: [
        { ref: 1, tag: "button", text: "Save", selector: "#save", disabled: true },
      ],
    });
    assert.ok(output.includes("(disabled)"));
  });
});
