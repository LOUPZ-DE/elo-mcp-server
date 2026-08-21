import type { Config } from './config.js';

// The OAuth and authn modules are leaf modules that all need the same config.
// Threading it through every signature would add noise without adding safety,
// and importing `loadConfig()` directly in each of them would parse the
// environment several times and lose the single, friendly startup error that
// src/index.ts prints. So the entry point publishes the parsed config here once
// and everything else reads it back.

let current: Config | undefined;

export function setConfig(cfg: Config): void {
  current = cfg;
}

export function config(): Config {
  if (!current) {
    throw new Error(
      'Runtime config was read before setConfig() ran. The entry point must call ' +
        'setConfig(loadConfig()) before touching any OAuth module.',
    );
  }
  return current;
}
