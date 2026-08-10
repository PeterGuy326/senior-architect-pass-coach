import { readFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { CoachError } from "./errors.mjs";
import { employeePackageDirectory } from "./paths.mjs";

const validators = new Map();

async function schemaPathFor(entrypoint) {
  const manifest = JSON.parse(
    await readFile(path.join(employeePackageDirectory, "employee.json"), "utf8"),
  );
  const portablePath = manifest?.entrypoints?.[entrypoint];
  if (typeof portablePath !== "string" || !portablePath.startsWith("./")) {
    throw new CoachError("INVALID_EMPLOYEE_MANIFEST", `员工包缺少 ${entrypoint}。`);
  }
  const filePath = path.resolve(employeePackageDirectory, portablePath.slice(2));
  const relative = path.relative(employeePackageDirectory, filePath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new CoachError("INVALID_EMPLOYEE_MANIFEST", `${entrypoint} 越出员工包目录。`);
  }
  return filePath;
}

async function validatorFor(entrypoint) {
  const filePath = await schemaPathFor(entrypoint);
  if (!validators.has(filePath)) {
    validators.set(filePath, (async () => {
      const schema = JSON.parse(await readFile(filePath, "utf8"));
      // Workbench uses the same Draft 2020-12 contract as the framework and
      // additionally treats strict-schema warnings as build/runtime failures.
      const ajv = new Ajv2020({
        allErrors: true,
        allowUnionTypes: true,
        strict: true,
        validateSchema: true,
      });
      return ajv.compile(schema);
    })());
  }
  return validators.get(filePath);
}

async function validate(entrypoint, value, code, label) {
  const validator = await validatorFor(entrypoint);
  if (!validator(value)) {
    const details = (validator.errors || []).map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message,
    }));
    throw new CoachError(code, `${label} 不符合员工包 Schema。`, { details });
  }
  return value;
}

export function validateEmployeeInput(value) {
  return validate(
    "inputSchema",
    value,
    "INVALID_EMPLOYEE_INPUT",
    "教学输入",
  );
}

export function validateEmployeeOutput(value) {
  return validate(
    "outputSchema",
    value,
    "INVALID_AGENT_PROPOSAL",
    "智能体输出",
  );
}
