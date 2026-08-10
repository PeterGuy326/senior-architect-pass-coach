import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConversationSessionStore,
  SESSION_DIRECTORY_NAME,
  SESSION_SCHEMA_VERSION,
} from "../service/session-store.mjs";

async function fixture(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-session-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return {
    dataDirectory,
    store: new ConversationSessionStore({ dataDirectory, ...options }),
  };
}

test("session JSON round-trips under owner-only permissions", async (t) => {
  const times = [
    new Date("2026-08-10T01:00:00.000Z"),
    new Date("2026-08-10T01:01:00.000Z"),
  ];
  const { dataDirectory, store } = await fixture(t, {
    idFactory: () => "session-one",
    clock: () => times.shift(),
  });
  const created = await store.create({ state: { harness: { state: "ready", tasks: [1, 2] } } });
  assert.equal(created.schema_version, SESSION_SCHEMA_VERSION);
  assert.equal(created.session_id, "session-one");
  assert.equal(created.revision, 1);

  const saved = await store.save(created.session_id, {
    expectedRevision: created.revision,
    state: { harness: { state: "awaiting_answer", item_id: "item-1" } },
  });
  assert.equal(saved.revision, 2);
  assert.deepEqual((await store.load(created.session_id)).state, saved.state);

  const sessionDirectory = path.join(dataDirectory, SESSION_DIRECTORY_NAME);
  const filePath = path.join(sessionDirectory, "session-one.r2.json");
  if (process.platform !== "win32") {
    assert.equal((await lstat(sessionDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(sessionDirectory, "session-one.r1.json"))).mode & 0o777, 0o600);
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).state, saved.state);
  assert.equal((await readdir(sessionDirectory)).some((name) => /lock|owner/.test(name)), false);
});

test("save and close enforce optimistic revisions and active listing", async (t) => {
  const { store } = await fixture(t);
  const first = await store.create({ sessionId: "first", state: { step: 1 } });
  const second = await store.create({ sessionId: "second", state: { step: 1 } });
  const updated = await store.save(first.session_id, {
    expectedRevision: first.revision,
    state: { step: 2 },
  });

  await assert.rejects(
    store.save(first.session_id, { expectedRevision: 1, state: { step: 3 } }),
    (error) => (
      error.code === "SESSION_REVISION_CONFLICT" &&
      error.details.expectedRevision === 1 &&
      error.details.actualRevision === 2
    ),
  );

  const closed = await store.close(first.session_id, { expectedRevision: updated.revision });
  assert.equal(closed.status, "closed");
  assert.equal(closed.revision, 3);
  assert.deepEqual((await store.listActive()).map((item) => item.session_id), [second.session_id]);
  await assert.rejects(
    store.save(first.session_id, { expectedRevision: closed.revision, state: { step: 4 } }),
    (error) => error.code === "SESSION_CLOSED",
  );
});

test("24 concurrent publishers claim exactly one immutable revision across rounds", async (t) => {
  const { store } = await fixture(t);
  const createResults = await Promise.allSettled(Array.from({ length: 24 }, (_, writer) => (
    store.create({ sessionId: "concurrent", state: { writer, round: 0 } })
  )));
  assert.equal(createResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(createResults.filter((result) => result.status === "rejected").length, 23);

  let current = await store.load("concurrent");
  for (let round = 1; round <= 3; round += 1) {
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, writer) => (
      store.save(current.session_id, {
        expectedRevision: current.revision,
        state: { writer, round },
      })
    )));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 23);
    assert.equal(
      results.filter((result) => result.status === "rejected")
        .every((result) => result.reason.code === "SESSION_REVISION_CONFLICT"),
      true,
    );
    current = await store.load(current.session_id);
    assert.equal(current.revision, round + 1);
    assert.equal(current.state.round, round);
  }

  const closeResults = await Promise.allSettled(Array.from({ length: 24 }, () => (
    store.close(current.session_id, { expectedRevision: current.revision })
  )));
  assert.equal(closeResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(closeResults.filter((result) => result.status === "rejected").length, 23);
  assert.equal((await store.load(current.session_id)).revision, current.revision + 1);
});

test("a failure injected after publication still leaves the new revision recoverable", async (t) => {
  const { dataDirectory, store } = await fixture(t, {
    async afterPublish({ revision }) {
      if (revision === 2) throw new Error("injected failure after publish");
    },
  });
  const created = await store.create({ sessionId: "interrupted", state: { step: 1 } });
  await assert.rejects(
    store.save(created.session_id, {
      expectedRevision: created.revision,
      state: { step: 2 },
    }),
    /injected failure after publish/,
  );

  const recovered = await store.load(created.session_id);
  assert.equal(recovered.revision, 2);
  assert.deepEqual(recovered.state, { step: 2 });

  const sessionDirectory = path.join(dataDirectory, SESSION_DIRECTORY_NAME);
  await writeFile(
    path.join(sessionDirectory, ".interrupted.r3.abandoned.tmp"),
    "{unfinished\n",
    { mode: 0o600 },
  );
  assert.equal((await store.load(created.session_id)).revision, 2);
});

test("load stops at the highest continuous valid revision and ignores temporary files", async (t) => {
  const { dataDirectory, store } = await fixture(t);
  const created = await store.create({ sessionId: "sequence", state: { step: 1 } });
  const sessionDirectory = path.join(dataDirectory, SESSION_DIRECTORY_NAME);
  const first = JSON.parse(await readFile(
    path.join(sessionDirectory, "sequence.r1.json"),
    "utf8",
  ));
  await writeFile(
    path.join(sessionDirectory, "sequence.r3.json"),
    `${JSON.stringify({
      ...first,
      revision: 3,
      updated_at: "2026-08-10T03:00:00.000Z",
      state: { step: 3 },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(sessionDirectory, ".sequence.r2.unpublished.tmp"),
    "{unfinished\n",
    { mode: 0o600 },
  );
  assert.equal((await store.load(created.session_id)).revision, 1);

  await writeFile(
    path.join(sessionDirectory, "sequence.r2.json"),
    "{invalid-published-json\n",
    { mode: 0o600 },
  );
  assert.equal((await store.load(created.session_id)).revision, 1);
});

test("corrupt JSON, schema and revision fail closed", async (t) => {
  const { dataDirectory, store } = await fixture(t);
  const created = await store.create({ sessionId: "damaged", state: { step: 1 } });
  const filePath = path.join(dataDirectory, SESSION_DIRECTORY_NAME, "damaged.r1.json");

  await writeFile(filePath, "{not-json\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  await assert.rejects(
    store.load(created.session_id),
    (error) => error.code === "INVALID_SESSION_DOCUMENT",
  );

  const invalidRevision = {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: "damaged",
    revision: 0,
    status: "active",
    created_at: "2026-08-10T01:00:00.000Z",
    updated_at: "2026-08-10T01:00:00.000Z",
    closed_at: null,
    state: {},
  };
  await writeFile(filePath, `${JSON.stringify(invalidRevision)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  await assert.rejects(
    store.load(created.session_id),
    (error) => error.code === "INVALID_SESSION_DOCUMENT",
  );
});

test("session IDs and symlinks cannot escape the sessions directory", async (t) => {
  const { dataDirectory, store } = await fixture(t);
  for (const sessionId of ["../outside", "nested/session", "nested\\session", ".", "..", ""] ) {
    await assert.rejects(
      store.create({ sessionId, state: {} }),
      (error) => error.code === "INVALID_SESSION_ID",
    );
    await assert.rejects(
      store.load(sessionId),
      (error) => error.code === "INVALID_SESSION_ID",
    );
  }
  await store.listActive();
  const outsideFile = path.join(dataDirectory, "outside.json");
  await writeFile(outsideFile, "{}\n", { mode: 0o600 });
  await symlink(outsideFile, path.join(dataDirectory, SESSION_DIRECTORY_NAME, "linked.r1.json"));
  await assert.rejects(
    store.load("linked"),
    (error) => error.code === "INSECURE_SESSION_STORAGE",
  );
});

test("raw responses and trusted authorizations are never persisted", async (t) => {
  const { dataDirectory, store } = await fixture(t);
  await assert.rejects(
    store.create({ sessionId: "raw", state: { response: "B" } }),
    (error) => error.code === "SESSION_SENSITIVE_FIELD_FORBIDDEN",
  );

  const created = await store.create({ sessionId: "safe", state: { step: "ready" } });
  await assert.rejects(
    store.save(created.session_id, {
      expectedRevision: created.revision,
      state: { nested: { trustedAuthorizations: [{ token: "secret" }] } },
    }),
    (error) => error.code === "SESSION_SENSITIVE_FIELD_FORBIDDEN",
  );
  const filePath = path.join(dataDirectory, SESSION_DIRECTORY_NAME, "safe.r1.json");
  const persisted = await readFile(filePath, "utf8");
  assert.doesNotMatch(persisted, /secret|trustedAuthorizations|response/);
  assert.equal((await store.load(created.session_id)).revision, 1);
});

test("broad file permissions are rejected instead of exposing a session", async (t) => {
  if (process.platform === "win32") return;
  const { dataDirectory, store } = await fixture(t);
  await store.create({ sessionId: "permissions", state: {} });
  const filePath = path.join(dataDirectory, SESSION_DIRECTORY_NAME, "permissions.r1.json");
  await chmod(filePath, 0o644);
  await assert.rejects(
    store.load("permissions"),
    (error) => error.code === "INSECURE_SESSION_STORAGE",
  );
});
