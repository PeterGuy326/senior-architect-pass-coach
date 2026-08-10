import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTH_CONTEXT_FILE_NAME,
  initializeLocalAuth,
  loadLocalAuth,
} from "../service/auth-context.mjs";
import { assertPrivateDataDirectory, repositoryRoot } from "../service/paths.mjs";

test("repository paths are always forbidden for private data", () => {
  assert.throws(
    () => assertPrivateDataDirectory(path.join(repositoryRoot, ".study")),
    (error) => error.code === "REPOSITORY_DATA_DIRECTORY_FORBIDDEN",
  );
});

test("local authorization is private and rejects broad POSIX permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await initializeLocalAuth(directory);
  assert.equal(context.authenticated, true);
  assert.match(context.user_id, /^local:/);
  if (process.platform !== "win32") {
    await chmod(path.join(directory, AUTH_CONTEXT_FILE_NAME), 0o644);
    await assert.rejects(
      loadLocalAuth(directory, { required: true }),
      (error) => error.code === "INSECURE_LOCAL_AUTH",
    );
  }
});

test("an outside symlink cannot redirect private data into the repository", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-coach-link-"));
  const link = path.join(directory, "data-link");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(repositoryRoot, link, "dir");
  assert.throws(
    () => assertPrivateDataDirectory(link),
    (error) => error.code === "SYMLINK_DATA_DIRECTORY_FORBIDDEN",
  );
});
