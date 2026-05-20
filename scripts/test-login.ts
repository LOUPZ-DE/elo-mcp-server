import { loadConfig } from '../src/utils/config.js';
import { EloClient } from '../src/elo/client.js';

async function main() {
  const cfg = loadConfig();
  const client = new EloClient({
    baseUrl: cfg.ELO_BASE_URL,
    username: cfg.ELO_USERNAME,
    password: cfg.ELO_PASSWORD,
    basicAuthUser: cfg.ELO_BASIC_AUTH_USER,
    basicAuthPass: cfg.ELO_BASIC_AUTH_PASS,
    language: cfg.ELO_LANGUAGE,
    country: cfg.ELO_COUNTRY,
    timeZone: cfg.ELO_TIMEZONE,
  });

  try {
    await client.login();
    console.log('Login OK');
    process.exit(0);
  } catch (err) {
    console.error('Login failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
