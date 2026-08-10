export class CoachError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CoachError";
    this.code = code;
    this.exitCode = options.exitCode ?? 2;
    this.details = options.details;
  }
}

export function publicError(error) {
  if (error instanceof CoachError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
    };
  }
  return {
    status: "error",
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
