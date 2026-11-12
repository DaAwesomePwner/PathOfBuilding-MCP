import os from 'node:os';
import path from 'node:path';

/**
 * Normalise a user-supplied path (env var, saved config, tool argument):
 *  - trims whitespace and one pair of surrounding quotes ("..." or '...'),
 *  - expands a leading `~` to the home directory,
 *  - expands `%VAR%` (any platform) and `$VAR` / `${VAR}` references — only when
 *    `expandEnv` is true (env-var / saved-config values). Tool arguments must
 *    pass false so a model can't read the server's environment through error text,
 *  - strips trailing separators (but never reduces a root like `C:\` or `/`),
 *  - resolves to an absolute path.
 * Returns null for an empty value.
 */
export function normalizeUserPath(
  raw: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
  options: { expandEnv?: boolean } = {},
): string | null {
  if (raw === undefined || raw === null) return null;
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  if (value.length === 0) return null;

  if (options.expandEnv !== false) value = expandEnvVars(value, env);

  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(homeDir(env), value.slice(1));
  }

  value = path.resolve(value);
  const root = path.parse(value).root;
  while (value.length > root.length && /[\\/]$/.test(value)) {
    value = value.slice(0, -1);
  }
  return value;
}

/** Expand `%VAR%`, `${VAR}` and `$VAR`. Unknown variables are left untouched. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const lookup = (name: string): string | undefined => {
    if (env[name] !== undefined) return env[name];
    // Windows env var names are case-insensitive.
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
  };
  return value
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name: string) => lookup(name) ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => lookup(name) ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => lookup(name) ?? m);
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME;
  return preferred || os.homedir();
}
