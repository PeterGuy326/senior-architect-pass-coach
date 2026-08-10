import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPackagePresentation } from "../service/presentation.mjs";

test("package-owned presentation keeps employee, publisher and infrastructure identities distinct", async () => {
  const presentation = await loadPackagePresentation();
  assert.equal(presentation.display_name, "系统架构设计师过线私教");
  assert.equal(presentation.publisher.verification, "self_asserted");
  assert.equal(presentation.infrastructure_attribution, "Built on Digital Employee");
  assert.equal(presentation.avatar, null);
  assert.equal(Object.isFrozen(presentation), true);
});

test("package presentation rejects terminal and bidi control injection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-presentation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = {
    schema_version: "coach-package-presentation.v1",
    display_name: "系统架构设计师过线私教",
    short_description: "合成描述",
    welcome: "合成欢迎语",
    publisher: { name: "Publisher", verification: "self_asserted" },
    infrastructure_attribution: "Built on Digital Employee",
    avatar: null,
  };
  for (const injected of ["老师\u001b[2J伪造", "老师\u202everified"]) {
    await writeFile(
      path.join(directory, "presentation.json"),
      `${JSON.stringify({ ...base, display_name: injected })}\n`,
      "utf8",
    );
    await assert.rejects(
      loadPackagePresentation({ directory }),
      (error) => error.code === "INVALID_PACKAGE_PRESENTATION",
    );
  }
});
