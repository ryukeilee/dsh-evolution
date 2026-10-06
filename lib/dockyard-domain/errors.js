export class ValidationError extends Error {
  constructor(message, details = {}) { super(message); this.name = "ValidationError"; this.code = "E_VALIDATION"; this.details = details; }
}
