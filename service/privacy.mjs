import { CoachError } from "./errors.mjs";

const SUBJECTS = ["comprehensive", "case", "essay"];

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanSubject(subject = {}) {
  return {
    status: typeof subject.status === "string" ? subject.status : "unmeasured",
    latest_mock_score: finiteOrNull(subject.latest_mock_score),
    lower_bound_score: finiteOrNull(subject.lower_bound_score),
    evidence_level: typeof subject.evidence_level === "string" ? subject.evidence_level : "cold_start",
    evidence_count: Number.isInteger(subject.evidence_count) ? subject.evidence_count : 0,
  };
}

export function deidentifyProgressSnapshot(status, recommendation) {
  if (!status || typeof status !== "object" || !recommendation || typeof recommendation !== "object") {
    throw new CoachError("INVALID_PROGRESS_SNAPSHOT", "无法从进度引擎构造安全快照。", {
      exitCode: 1,
    });
  }
  const subjects = Object.fromEntries(
    SUBJECTS.map((name) => [name, cleanSubject(status.subjects?.[name])]),
  );
  const recommendations = (Array.isArray(recommendation.recommendations)
    ? recommendation.recommendations
    : [])
    .slice(0, 3)
    .map((item) => ({
      topic_id: String(item.topic_id || ""),
      subject: String(item.subject || ""),
      skill: String(item.skill || ""),
      priority_score: finiteOrNull(item.priority_score),
      mastery: finiteOrNull(item.mastery),
      review_due: Boolean(item.review_due),
      estimated_minutes: finiteOrNull(item.estimated_minutes),
      reason_code: typeof item.reason_code === "string" ? item.reason_code : "deterministic_priority",
    }));
  return {
    schema_version: "deidentified-progress.v1",
    subjects,
    target_subject: typeof recommendation.target_subject === "string"
      ? recommendation.target_subject
      : null,
    maintenance_subject: typeof recommendation.maintenance_subject === "string"
      ? recommendation.maintenance_subject
      : null,
    crunch_mode: Boolean(recommendation.crunch_mode),
    days_to_exam: Number.isInteger(recommendation.days_to_exam)
      ? recommendation.days_to_exam
      : null,
    recommendations,
  };
}

export function assertNoIdentityFields(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["user_id", "name", "email", "background", "resource", "source_path"]) {
    if (new RegExp(`\\"${forbidden}s?\\"`, "i").test(serialized)) {
      throw new CoachError("IDENTITY_FIELD_LEAK", `去标识化快照包含禁止字段：${forbidden}。`);
    }
  }
  return value;
}
