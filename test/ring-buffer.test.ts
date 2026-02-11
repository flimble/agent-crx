import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../src/daemon.js";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const buf = new RingBuffer<number>(5);
    assert.equal(buf.size, 0);
    assert.deepEqual(buf.query(), []);
  });

  it("push and query", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    assert.equal(buf.size, 3);
    assert.deepEqual(buf.query(), [1, 2, 3]);
  });

  it("wraps around at capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    assert.equal(buf.size, 3);
    assert.deepEqual(buf.query(), [2, 3, 4]);
  });

  it("overwrites oldest on overflow", () => {
    const buf = new RingBuffer<string>(2);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    assert.equal(buf.size, 2);
    assert.deepEqual(buf.query(), ["c", "d"]);
  });

  it("query with filter", () => {
    const buf = new RingBuffer<number>(10);
    for (let i = 1; i <= 6; i++) buf.push(i);
    const evens = buf.query((n) => n % 2 === 0);
    assert.deepEqual(evens, [2, 4, 6]);
  });

  it("query with limit", () => {
    const buf = new RingBuffer<number>(10);
    for (let i = 1; i <= 6; i++) buf.push(i);
    assert.deepEqual(buf.query(undefined, 3), [4, 5, 6]);
  });

  it("query with filter and limit", () => {
    const buf = new RingBuffer<number>(10);
    for (let i = 1; i <= 10; i++) buf.push(i);
    const result = buf.query((n) => n % 2 === 0, 2);
    assert.deepEqual(result, [8, 10]);
  });

  it("clear resets everything", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    assert.equal(buf.size, 0);
    assert.deepEqual(buf.query(), []);
  });

  it("works after clear and re-fill", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    buf.push(10);
    buf.push(20);
    assert.equal(buf.size, 2);
    assert.deepEqual(buf.query(), [10, 20]);
  });

  it("capacity of 1", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    assert.deepEqual(buf.query(), ["a"]);
    buf.push("b");
    assert.deepEqual(buf.query(), ["b"]);
    assert.equal(buf.size, 1);
  });

  it("large overflow", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 100; i++) buf.push(i);
    assert.equal(buf.size, 3);
    assert.deepEqual(buf.query(), [97, 98, 99]);
  });
});
