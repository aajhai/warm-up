import test from "node:test";
import assert from "node:assert/strict";
import { completedSessionToday, orderByProxy, pickNext } from "../scripts/proxy-queue.mjs";

function fill(port, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${port}-${index}`,
    name: `p-${port}-${index}`,
    port: String(port),
  }));
}

test("Available Profiles port mix never places the same proxy on two consecutive runs", () => {
  const items = [
    ...fill(5001, 15),
    ...fill(5004, 10),
    ...fill(5005, 6),
    ...fill(5002, 1),
    ...fill(5003, 1),
    ...fill(5007, 1),
  ];
  const { ordered, deferred } = orderByProxy(items);
  assert.equal(deferred.length, 0);
  assert.equal(ordered.length, items.length);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.notEqual(ordered[index].port, ordered[index - 1].port);
  }
});

test("stops instead of repeating the previous port when nothing else is left", () => {
  const items = [...fill(5005, 3), ...fill(5001, 1)];
  const { ordered, deferred } = orderByProxy(items);
  assert.deepEqual(ordered.map((item) => item.port), ["5005", "5001", "5005"]);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].port, "5005");
  assert.equal(pickNext(deferred, "5005"), null);
});

test("a later failure does not hide an earlier completed session the same day", () => {
  const state = {
    lastSession: { dateKey: "2026-10-09", aborted: true, testRun: false },
    history: [
      { dateKey: "2026-10-09", aborted: false, testRun: false },
      { dateKey: "2026-10-09", aborted: true, testRun: false },
    ],
  };
  assert.equal(completedSessionToday(state, "2026-10-09"), true);
  assert.equal(completedSessionToday({ lastSession: { dateKey: "2026-10-09", aborted: true } }, "2026-10-09"), false);
  assert.equal(completedSessionToday({ lastSession: { dateKey: "2026-10-09", aborted: false, testRun: true } }, "2026-10-09"), false);
});

test("a profile that never opens a browser does not license the same port next", () => {
  const items = [...fill(5001, 2), ...fill(5004, 1)];
  const afterFirst = items.filter((item) => item.id !== "5001-0");
  assert.equal(pickNext(afterFirst, "5001").port, "5004");
  const blockedMiddleRemoved = afterFirst.filter((item) => item.id !== "5004-0");
  assert.equal(pickNext(blockedMiddleRemoved, "5001"), null);
});
