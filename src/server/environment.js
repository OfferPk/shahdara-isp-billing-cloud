import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseEnvFile(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].startsWith('"')) value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export async function loadEnvironment({ cwd = process.cwd(), processEnv = process.env } = {}) {
  const fileValues = {};
  for (const filename of ['.env', '.env.local']) {
    try {
      Object.assign(fileValues, parseEnvFile(await readFile(resolve(cwd, filename), 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...fileValues, ...processEnv };
}

export const environmentInternals = Object.freeze({ parseEnvFile });
