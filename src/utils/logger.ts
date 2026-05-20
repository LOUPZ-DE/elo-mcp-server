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
      ],
      censor: '[REDACTED]',
    },
  },
  // MCP stdio transport uses stdout for JSON-RPC. Logs MUST go to stderr.
  pino.destination(2),
);
