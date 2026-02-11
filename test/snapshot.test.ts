import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSnapshot, buildSnapshotExpression } from "../src/snapshot.js";
import type { SnapshotResult } from "../src/snapshot.js";

describe("formatSnapshot", () => {
  it("formats basic snapshot", () => {
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [],
      interactiveElements: [],
    };
    const output = formatSnapshot(result);
    assert.ok(output.includes("URL: https://example.com"));
    assert.ok(output.includes("Title: Example"));
  });

  it("formats watchlist", () => {
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [
        { label: "login-btn", selector: "#login", found: true },
        { label: "sidebar", selector: ".sidebar", found: false },
      ],
      interactiveElements: [],
    };
    const output = formatSnapshot(result);
    assert.ok(output.includes("[OK] login-btn: #login"));
    assert.ok(output.includes("[MISSING] sidebar: .sidebar"));
  });

  it("formats interactive elements with refs", () => {
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [],
      interactiveElements: [
        { ref: 1, tag: "button", text: "Click me", selector: "#btn" },
        { ref: 2, tag: "input", type: "email", text: "", selector: "#email", name: "email" },
        { ref: 3, tag: "a", text: "", href: "https://example.com/about", selector: "a.about" },
      ],
    };
    const output = formatSnapshot(result);
    assert.ok(output.includes('@1 button "Click me"'));
    assert.ok(output.includes("@2 input [email]"));
    assert.ok(output.includes("@3 a https://example.com/about"));
  });

  it("formats with extension info", () => {
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [],
      interactiveElements: [],
    };
    const output = formatSnapshot(result, { name: "MyExt", version: "1.2.3", errorCount: 2 });
    assert.ok(output.includes("Extension: MyExt v1.2.3 (loaded, 2 errors)"));
  });

  it("formats extension with zero errors", () => {
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [],
      interactiveElements: [],
    };
    const output = formatSnapshot(result, { name: "MyExt", version: "1.0.0", errorCount: 0 });
    assert.ok(output.includes("Extension: MyExt v1.0.0 (loaded)"));
    assert.ok(!output.includes("error"));
  });

  it("truncates long hrefs", () => {
    const longUrl = "https://example.com/" + "a".repeat(100);
    const result: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      readyState: "complete",
      watchlist: [],
      interactiveElements: [
        { ref: 1, tag: "a", text: "", href: longUrl, selector: "a" },
      ],
    };
    const output = formatSnapshot(result);
    assert.ok(output.includes("..."));
    assert.ok(!output.includes(longUrl));
  });
});

describe("buildSnapshotExpression", () => {
  it("returns a string containing the watch selectors", () => {
    const expr = buildSnapshotExpression([
      { label: "btn", selector: "#my-btn" },
    ]);
    assert.ok(typeof expr === "string");
    assert.ok(expr.includes("#my-btn"));
    assert.ok(expr.includes("btn"));
  });

  it("returns valid JS with empty selectors", () => {
    const expr = buildSnapshotExpression([]);
    assert.ok(expr.includes("watchSelectors"));
    assert.ok(expr.includes("interactiveElements"));
  });
});
