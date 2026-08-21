import pino from 'pino';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'userPwd',
        '*.userPwd',
        'password',
        '*.password',
        'ELO_PASSWORD',
        'headers.Cookie',
        'headers.cookie',
        'headers.authorization',
        'headers.Authorization',
        'config.headers.Cookie',
        'config.headers.cookie',
        // OAuth material. `code` and `code_verifier` are single-use, but a log
        // is read long after the fact and a refresh token is not single-use at
        // all — none of them belong in one.
        'code',
        '*.code',
        'code_verifier',
        '*.code_verifier',
        'access_token',
        '*.access_token',
        'refresh_token',
        '*.refresh_token',
        'client_secret',
        '*.client_secret',
        'body.password',
        'req.body.password',
      ],
      censor: '[REDACTED]',
    },
  },
  // MCP stdio transport uses stdout for JSON-RPC. Logs MUST go to stderr.
  pino.destination(2),
);
