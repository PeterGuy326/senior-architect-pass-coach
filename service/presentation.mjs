import { readFile } from "node:fs/promises";
import path from "node:path";

import { CoachError } from "./errors.mjs";
import { employeePackageDirectory } from "./paths.mjs";

function presentationError(message, options = {}) {
  return new CoachError("INVALID_PACKAGE_PRESENTATION", message, options);
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw presentationError(`${label} 必须是长度不超过 ${maximum} 的纯文本。`);
  }
  if (/[<>\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw presentationError(`${label} 不能包含主动标记、终端控制符或双向文本控制符。`);
  }
  return value.trim();
}

export async function loadPackagePresentation({ directory = employeePackageDirectory } = {}) {
  let value;
  try {
    value = JSON.parse(await readFile(path.join(directory, "presentation.json"), "utf8"));
  } catch (error) {
    throw presentationError("员工品牌 sidecar 缺失或不是有效 JSON。", { cause: error });
  }
  const exact = [
    "schema_version",
    "display_name",
    "short_description",
    "welcome",
    "publisher",
    "infrastructure_attribution",
    "avatar",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== exact.length ||
    Object.keys(value).some((key) => !exact.includes(key)) ||
    value.schema_version !== "coach-package-presentation.v1" ||
    value.avatar !== null ||
    !value.publisher ||
    typeof value.publisher !== "object" ||
    Array.isArray(value.publisher) ||
    value.publisher.verification !== "self_asserted" ||
    Object.keys(value.publisher).some((key) => !["name", "verification"].includes(key))
  ) {
    throw presentationError("员工品牌 sidecar 字段或真实性声明无效。 ");
  }
  return Object.freeze({
    schema_version: value.schema_version,
    display_name: boundedText(value.display_name, "display_name", 80),
    short_description: boundedText(value.short_description, "short_description", 240),
    welcome: boundedText(value.welcome, "welcome", 500),
    publisher: Object.freeze({
      name: boundedText(value.publisher.name, "publisher.name", 80),
      verification: "self_asserted",
    }),
    infrastructure_attribution: boundedText(
      value.infrastructure_attribution,
      "infrastructure_attribution",
      120,
    ),
    avatar: null,
  });
}
