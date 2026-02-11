import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClickExpression, buildFillExpression } from "../src/click.js";

describe("buildClickExpression", () => {
  it("returns a string with the selector", () => {
    const expr = buildClickExpression("#my-button");
    assert.ok(typeof expr === "string");
    assert.ok(expr.includes("#my-button"));
  });

  it("handles shadow DOM selectors with >>>", () => {
    const expr = buildClickExpression("my-component>>>#inner-btn");
    assert.ok(expr.includes(">>>"));
    assert.ok(expr.includes("shadowRoot"));
  });

  it("returns valid JS IIFE", () => {
    const expr = buildClickExpression("button.submit");
    assert.ok(expr.startsWith("(()"));
    assert.ok(expr.endsWith("})()"));
  });
});

describe("buildFillExpression", () => {
  it("includes selector and value", () => {
    const expr = buildFillExpression("#email", "test@example.com");
    assert.ok(expr.includes("#email"));
    assert.ok(expr.includes("test@example.com"));
  });

  it("handles shadow DOM selectors", () => {
    const expr = buildFillExpression("my-form>>>#input", "hello");
    assert.ok(expr.includes(">>>"));
    assert.ok(expr.includes("shadowRoot"));
  });

  it("dispatches input and change events", () => {
    const expr = buildFillExpression("#field", "value");
    assert.ok(expr.includes("input"));
    assert.ok(expr.includes("change"));
  });
});
