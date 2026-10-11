const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPollingHarness(telemetryGetter) {
  const source = fs.readFileSync(
    path.resolve("src/renderer/App.tsx"),
    "utf8",
  );

  const opening = "const fallbackPollTimer = setInterval(";
  const closing = "}, 2000);";
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, "Expected the candidate polling block");

  const end = source.indexOf(closing, start);
  assert.notEqual(end, -1, "Expected the 2000 ms interval terminator");

  const pollingBlock = source.slice(start, end + closing.length);
  const telemetryWrites = [];
  let tick;
  let intervalActive = false;

  const context = vm.createContext({
    api: {
      telemetry: { getSnapshot: telemetryGetter },
      loop: { getSnapshot: () => Promise.resolve(null) },
      mcp: { getSnapshot: () => Promise.resolve(null) },
      subagents: { getSubagents: () => Promise.resolve(null) },
    },
    setTelemetry: (snapshot) => telemetryWrites.push(snapshot),
    setLoopState: () => {},
    setMcpState: () => {},
    setSubagents: () => {},
    setInterval: (callback, milliseconds) => {
      assert.equal(milliseconds, 2000);
      tick = callback;
      intervalActive = true;
      return 1;
    },
    clearInterval: (handle) => {
      assert.equal(handle, 1);
      intervalActive = false;
    },
  });

  vm.runInContext(
    `${pollingBlock}\nglobalThis.pollHandle = fallbackPollTimer;`,
    context,
  );

  return {
    telemetryWrites,
    advanceInterval() {
      if (intervalActive) tick();
    },
    pushTelemetry(snapshot) {
      context.setTelemetry(snapshot);
    },
    unmount() {
      // The cleanup operation present in the supplied implementation.
      context.clearInterval(context.pollHandle);
    },
  };
}

async function drainPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("POLL-01: a pending snapshot prevents another request in its domain", async () => {
  const pending = deferred();
  let requests = 0;

  const harness = createPollingHarness(() => {
    requests += 1;
    return pending.promise;
  });

  try {
    harness.advanceInterval();
    harness.advanceInterval();

    assert.equal(
      requests,
      1,
      "A second interval tick must not overlap the pending telemetry request",
    );
  } finally {
    harness.unmount();
    pending.resolve(null);
    await drainPromises();
  }
});

test("POLL-02: an older polling response cannot replace a newer pushed snapshot", async () => {
  const pending = deferred();
  const harness = createPollingHarness(() => pending.promise);
  const olderPollSnapshot = { marker: "older-poll" };
  const newerPushSnapshot = { marker: "newer-push" };

  try {
    harness.advanceInterval();
    harness.pushTelemetry(newerPushSnapshot);

    pending.resolve(olderPollSnapshot);
    await drainPromises();

    assert.deepEqual(
      harness.telemetryWrites,
      [newerPushSnapshot],
      "The polling fulfillment must not apply after a newer IPC update",
    );
  } finally {
    harness.unmount();
    pending.resolve(null);
    await drainPromises();
  }
});

test("POLL-03: clearing the interval must also prevent pending responses from applying", async () => {
  const pending = deferred();
  let requests = 0;

  const harness = createPollingHarness(() => {
    requests += 1;
    return pending.promise;
  });

  harness.advanceInterval();
  harness.unmount();
  harness.advanceInterval();

  assert.equal(requests, 1, "Cleanup must prevent future interval requests");

  pending.resolve({ marker: "resolved-after-unmount" });
  await drainPromises();

  assert.deepEqual(
    harness.telemetryWrites,
    [],
    "An outstanding snapshot must not apply after effect cleanup",
  );
});
