import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/tmp/nonexistent-dir-12345");
    assert.equal(config.port, 9222);
    assert.equal(config.daemonPort, 9300);
    assert.equal(config.name, "extension");
    assert.deepEqual(config.console.filters, []);
    assert.equal(config.console.showUnmatched, true);
    assert.deepEqual(config.network.filters, []);
    assert.equal(config.network.showUnmatched, true);
    assert.deepEqual(config.dom.selectors, []);
    assert.equal(config.tabFilter, undefined);
  });

  it("overrides take precedence", () => {
    const config = loadConfig("/tmp/nonexistent-dir-12345", {
      port: 9333,
      daemonPort: 9400,
      tabFilter: "mysite.com",
    });
    assert.equal(config.port, 9333);
    assert.equal(config.daemonPort, 9400);
    assert.equal(config.tabFilter, "mysite.com");
  });
});
