import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { now, generateSessionId } from "../src/events.js";

describe("now", () => {
  it("returns ISO string", () => {
    const ts = now();
    assert.ok(ts.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));
    assert.ok(!isNaN(Date.parse(ts)));
  });
});

describe("generateSessionId", () => {
  it("returns 8-char hex string", () => {
    const id = generateSessionId();
    assert.equal(id.length, 8);
    assert.ok(id.match(/^[0-9a-f]{8}$/));
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    assert.ok(ids.size > 90);
  });
});
