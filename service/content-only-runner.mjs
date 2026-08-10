import { createSealedEmployeePackageSnapshot } from "@fullstack-ai-infra/digital-employee/host-runtime";

import { CoachError } from "./errors.mjs";
import { REVIEW_SOURCE_REF } from "./content-provider.mjs";
import { employeePackageDirectory } from "./paths.mjs";
import { loadPackagePresentation } from "./presentation.mjs";

const SOURCE = REVIEW_SOURCE_REF;
const defaultRuntime = Object.freeze({ createSealedEmployeePackageSnapshot });

function runnerError(code, message) {
  return new CoachError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runnerError("INVALID_CONTENT_ONLY_INPUT", `${label} 必须是对象。`);
  }
  return value;
}

function baseResult(input, action) {
  return {
    schema_version: "architect-pass-coach-teaching-result.v1",
    action,
    status: "completed",
    scope: input.context.authenticated ? "personalized" : "general",
    summary: action === "submit"
      ? "已依据本地密封答案键完成判定。"
      : "已从用户提供的本地复习资料中选择一道练习题。",
    score_goal: { pass_line: 45, safety_target: 52 },
    answer_visibility: action === "submit" ? "revealed_after_submission" : "hidden",
    state_write_performed: false,
    assessments: [],
    learning_items: [],
    feedback: [],
    recommendations: [],
    source_refs: [SOURCE],
  };
}

function trustedGradeFrom(input) {
  const materials = input.request.approved_materials;
  if (!Array.isArray(materials) || materials.length < 1) {
    throw runnerError("TRUSTED_GRADE_MISSING", "content-only submit 缺少本地可信判定材料。 ");
  }
  for (const material of materials) {
    try {
      const parsed = JSON.parse(material.excerpt);
      if (parsed?.trusted_grade) return object(parsed.trusted_grade, "trusted_grade");
    } catch {
      // Other approved material can be plain text. Keep looking for the sealed
      // local grade projection created by the Harness.
    }
  }
  throw runnerError("TRUSTED_GRADE_MISSING", "content-only submit 找不到本地可信判定。 ");
}

/**
 * Deterministic no-model runner. It exercises the exact employee input/output
 * contract and the same Harness as Agent Host mode, so candidates can study
 * before configuring a model credential. It never grades by itself.
 */
export class ContentOnlyCoachRunner {
  mode = "content-only";

  constructor({
    directory = employeePackageDirectory,
    runtime = defaultRuntime,
    presentationLoader = loadPackagePresentation,
  } = {}) {
    this.directory = directory;
    this.runtime = runtime;
    this.presentationLoader = presentationLoader;
    this.pinnedDigest = null;
    this.employee = null;
  }

  async preflight() {
    const snapshot = await this.runtime.createSealedEmployeePackageSnapshot(this.directory);
    try {
      const presentation = await this.presentationLoader({ directory: snapshot.directory });
      this.pinnedDigest = snapshot.digest;
      this.employee = {
        name: snapshot.manifest.name,
        version: snapshot.manifest.version,
      };
      return {
        engine: null,
        digest: snapshot.digest,
        employee: { ...this.employee },
        presentation,
      };
    } finally {
      await snapshot.cleanup();
    }
  }

  async run(input) {
    if (!this.pinnedDigest) await this.preflight();
    const snapshot = await this.runtime.createSealedEmployeePackageSnapshot(this.directory);
    try {
      if (snapshot.digest !== this.pinnedDigest) {
        throw runnerError(
          "EMPLOYEE_PACKAGE_CHANGED",
          "数字员工包在会话期间发生变化；请重新开始会话并复核新版本。",
        );
      }

      object(input, "employee input");
      const action = input.action;
      const activeItem = object(input.request?.active_item, "request.active_item");
      const result = baseResult(input, action);
      if (action !== "submit") {
        result.learning_items = [structuredClone(activeItem)];
        return { teaching_result: result, proposed_progress_events: [] };
      }

      const grade = trustedGradeFrom(input);
      if (grade.item_id !== activeItem.item_id) {
        throw runnerError("TRUSTED_GRADE_MISMATCH", "本地可信判定与当前题目不一致。 ");
      }
      result.assessments = [{
        subject: grade.subject,
        topic_id: grade.topic_id,
        result: grade.result,
        evidence: grade.correct
          ? "本地密封答案键判定选项正确。"
          : "本地密封答案键判定选项错误。",
      }];
      result.feedback = [{
        item_id: grade.item_id,
        result: grade.result,
        reference_answer: grade.reference_answer,
        explanation: grade.explanation,
        source_refs: structuredClone(grade.source_refs),
      }];
      return {
        teaching_result: result,
        proposed_progress_events: [{
          schema_version: "progress-event-proposal.v1",
          event_type: grade.event_type,
          subject: grade.subject,
          topic_id: grade.topic_id,
          result: grade.result,
          evidence: {
            item_id: grade.item_id,
            summary: grade.correct ? "本地客观题作答正确" : "本地客观题作答错误",
          },
          proposal_only: true,
          requires_authenticated_context: true,
        }],
      };
    } finally {
      await snapshot.cleanup();
    }
  }
}
