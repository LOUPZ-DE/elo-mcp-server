import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ELO_BASE_URL: z.string().url(),
  ELO_WEBCLIENT_URL: z.string().url(),
  ELO_USERNAME: z.string().min(1),
  ELO_PASSWORD: z.string().min(1),
  // The Loupz nginx in front of IX requires HTTP Basic Auth on every path
  // except /login. By default we reuse the ELO credentials (they work for
  // both layers). Override only if IT splits the two later.
  ELO_BASIC_AUTH_USER: z.string().optional(),
  ELO_BASIC_AUTH_PASS: z.string().optional(),
  ELO_LANGUAGE: z.string().default('de'),
  ELO_COUNTRY: z.string().default('DE'),
  ELO_TIMEZONE: z.string().default('UTC'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Transport: `stdio` for local Claude Desktop subprocess usage; `http` for
  // remote hosting (Easypanel, etc.). HTTP mode requires MCP_SHARED_SECRET.
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3000),
  MCP_HTTP_HOST: z.string().default('0.0.0.0'),
  MCP_SHARED_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }
  if (parsed.data.MCP_TRANSPORT === 'http' && !parsed.data.MCP_SHARED_SECRET) {
    throw new Error(
      'MCP_SHARED_SECRET is required when MCP_TRANSPORT=http (publicly exposed endpoint must authenticate).',
    );
  }
  return parsed.data;
}
