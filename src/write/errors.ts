/**
 * Errors the write path raises, kept apart so a caller can tell "you may not do
 * this" from "ELO said no" from "somebody changed it under you".
 *
 * All of them keep any original IX text verbatim in `message`. That is not
 * cosmetic: `isStaleCredentialError` in src/authn/eloLogin.ts recognises a
 * dead session by matching on the message, so a wrapper that reworded it would
 * silently stop the credential vault healing itself after a password change.
 */

/** The caller is not allowed to write at all — wrong identity, no session. */
export class WriteRefusedError extends Error {
  readonly code = 'WRITE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'WriteRefusedError';
  }
}

/** The request is well-formed but outside what this deployment permits. */
export class WritePolicyError extends Error {
  readonly code = 'WRITE_POLICY';
  constructor(message: string) {
    super(message);
    this.name = 'WritePolicyError';
  }
}

/** The confirmation token is missing, expired, spent, or bound to something else. */
export class WriteConfirmationError extends Error {
  readonly code = 'WRITE_CONFIRMATION';
  constructor(message: string) {
    super(message);
    this.name = 'WriteConfirmationError';
  }
}

/** The object changed between preparing and committing. */
export class WriteConflictError extends Error {
  readonly code = 'WRITE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'WriteConflictError';
  }
}
