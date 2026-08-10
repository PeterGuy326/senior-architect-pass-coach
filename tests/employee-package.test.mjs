import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const employeeRoot = path.join(repositoryRoot, "employee", "senior-architect-pass-coach");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(employeeRoot, relativePath), "utf8"));
}

const expectedActions = [
  "diagnose",
  "status",
  "today",
  "practice",
  "submit",
  "review",
  "mock",
  "case",
  "essay",
];

test("employee package uses the pinned portable structured-output contract", async () => {
  const manifest = await readJson("employee.json");
  assert.equal(manifest.schemaVersion, "employee-package.v1alpha1");
  assert.match(manifest.$schema, /\/v0\.3\.0\/configs\/employee-package\.schema\.json$/);
  assert.deepEqual(manifest.host.requiredCapabilities, ["structured_output"]);
  assert.equal(manifest.policy.mode, "read_only");
  assert.equal(manifest.policy.network, "deny");
  assert.deepEqual(manifest.policy.filesystem.write, []);
  assert.deepEqual(manifest.policy.mcpTools, []);
});

test("input contract is identity-free and matches the deidentified snapshot", async () => {
  const schema = await readJson("schemas/input.schema.json");
  assert.deepEqual(schema.$defs.action.enum, expectedActions);
  assert.deepEqual(schema.$defs.subject.enum, ["comprehensive", "case", "essay"]);
  assert.deepEqual(Object.keys(schema.$defs.context.properties), ["authenticated"]);
  assert.deepEqual(schema.$defs.context.required, ["authenticated"]);

  const snapshot = schema.$defs.progressSnapshot;
  assert.equal(snapshot.properties.schema_version.const, "deidentified-progress.v1");
  assert.deepEqual(
    Object.keys(snapshot.properties.subjects.properties),
    ["comprehensive", "case", "essay"],
  );
  assert.deepEqual(snapshot.required, [
    "schema_version",
    "subjects",
    "target_subject",
    "maintenance_subject",
    "crunch_mode",
    "days_to_exam",
    "recommendations",
  ]);
  assert.equal(snapshot.properties.recommendations.maxItems, 3);
});

test("output contract is proposal-only with three assessment states", async () => {
  const schema = await readJson("schemas/output.schema.json");
  assert.deepEqual(Object.keys(schema.properties), [
    "teaching_result",
    "proposed_progress_events",
  ]);
  assert.deepEqual(schema.$defs.result.enum, [
    "mastered",
    "not_mastered",
    "needs_retest",
  ]);
  assert.equal(
    schema.$defs.teachingResult.properties.recommendations.maxItems,
    3,
  );
  assert.equal(
    schema.$defs.teachingResult.properties.state_write_performed.const,
    false,
  );
  assert.equal(schema.$defs.progressEventProposal.properties.proposal_only.const, true);
  assert.equal(
    schema.$defs.progressEventProposal.properties.requires_authenticated_context.const,
    true,
  );
  assert.equal("user_id" in schema.$defs.progressEventProposal.properties, false);
});

test("public source manifest pins one reference without embedding content", async () => {
  const manifest = await readJson("knowledge/sources.json");
  assert.equal(manifest.schemaVersion, "public-source-manifest.v1");
  assert.equal(manifest.sources.length, 1);
  assert.deepEqual(manifest.sources[0], {
    id: "senior-software-architect-review",
    kind: "public_git_repository",
    url: "https://github.com/PeterGuy326/senior-software-architect-review",
    revision: "88f4bdc58e668ac887f2f06e152f69a1c129edd1",
    visibility: "public",
    usage: "reference_only",
    contentIncluded: false,
  });
});

test("offline fixtures cover all actions and preserve the answer gate", async () => {
  const fixture = await readJson("evals/cases.json");
  assert.equal(fixture.schemaVersion, "employee-evals.v1alpha1");
  assert.deepEqual(
    [...new Set(fixture.cases.map((item) => item.input.action))],
    expectedActions,
  );

  for (const item of fixture.cases) {
    const output = item.expectedOutput;
    assert.deepEqual(Object.keys(output), ["teaching_result", "proposed_progress_events"]);
    assert.equal(output.teaching_result.state_write_performed, false);
    assert.ok(output.teaching_result.recommendations.length <= 3);
    assert.deepEqual(Object.keys(item.input.context), ["authenticated"]);

    if (!item.input.context.authenticated) {
      assert.equal(item.input.action, "diagnose");
      assert.equal(item.input.request.diagnosis_scope, "general");
      assert.equal(output.teaching_result.scope, "general");
      assert.deepEqual(output.proposed_progress_events, []);
    }

    if (!("submission" in item.input.request)) {
      assert.notEqual(output.teaching_result.answer_visibility, "revealed_after_submission");
      assert.deepEqual(output.teaching_result.feedback, []);
      for (const learningItem of output.teaching_result.learning_items) {
        assert.equal("answer" in learningItem, false);
        assert.equal("reference_answer" in learningItem, false);
        assert.equal("explanation" in learningItem, false);
      }
    }
  }
});

test("portable schemas reject submission and answer leakage outside submit", async () => {
  const [inputSchema, outputSchema, fixture] = await Promise.all([
    readJson("schemas/input.schema.json"),
    readJson("schemas/output.schema.json"),
    readJson("evals/cases.json"),
  ]);
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    validateSchema: true,
  });
  const validateInput = ajv.compile(inputSchema);
  const validateOutput = ajv.compile(outputSchema);
  const practice = fixture.cases.find((item) => item.input.action === "practice");

  const inputWithEarlySubmission = structuredClone(practice.input);
  inputWithEarlySubmission.request.submission = {
    item_id: "practice-availability-1",
    response: "A",
  };
  assert.equal(validateInput(inputWithEarlySubmission), false);

  const outputWithEarlyAnswer = structuredClone(practice.expectedOutput);
  outputWithEarlyAnswer.teaching_result.answer_visibility = "revealed_after_submission";
  outputWithEarlyAnswer.teaching_result.feedback = [
    {
      item_id: "practice-availability-1",
      result: "mastered",
      reference_answer: "A",
      explanation: "This answer must remain hidden until submit.",
      source_refs: [],
    },
  ];
  assert.equal(validateOutput(outputWithEarlyAnswer), false);
});

test("Skill declares pass-first, authentication, and no-answer-leak rules", async () => {
  const skill = await readFile(path.join(employeeRoot, "SKILL.md"), "utf8");
  assert.match(skill, /45/);
  assert.match(skill, /52/);
  assert.match(skill, /每日推荐最多 3 项/);
  assert.match(skill, /匿名上下文只能执行 `diagnose`/);
  assert.match(skill, /作答前只返回题干和选项/);
  assert.match(skill, /不得直接更新学习状态/);
});
