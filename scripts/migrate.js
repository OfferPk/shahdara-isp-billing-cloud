#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_VERSION = '2.120.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env.local');

function readEnvFileValue(filePath, key) {
  if (!existsSync(filePath)) return '';

  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`));
    if (!match) continue;

    let value = match[1].trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return '';
}

function redact(text, databaseUrl) {
  return text
    .replaceAll(databaseUrl, '[DATABASE_URL REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[DATABASE_URL REDACTED]');
}

function printHelp() {
  console.log(`Usage: node scripts/migrate.js [--dry-run | --apply]

Default is --dry-run. It compares supabase/migrations with Supabase's remote
migration ledger and prints pending migrations without applying them.

Use --apply only after reviewing the dry-run list and receiving owner approval.
DATABASE_URL is read from the process environment first, then .env.local.`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}
if (args.some((arg) => !['--dry-run', '--apply'].includes(arg)) || (args.includes('--dry-run') && args.includes('--apply'))) {
  console.error('Use either --dry-run or --apply (not both).');
  process.exit(2);
}

const apply = args.includes('--apply');
const databaseUrl = (process.env.DATABASE_URL || readEnvFileValue(ENV_FILE, 'DATABASE_URL')).trim();
if (!databaseUrl) {
  console.error('DATABASE_URL was not found in the environment or .env.local.');
  console.error('Expected format: postgresql://postgres:[ENCODED_PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres');
  process.exit(2);
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  console.error('DATABASE_URL is not a valid PostgreSQL connection URI.');
  process.exit(2);
}
if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || !parsedUrl.username || !parsedUrl.password) {
  console.error('DATABASE_URL must be a PostgreSQL URI with a host, username, and password.');
  process.exit(2);
}

const cliArgs = [
  '--yes',
  `supabase@${CLI_VERSION}`,
  'db',
  'push',
  '--db-url',
  databaseUrl,
  '--skip-vault',
];
if (apply) {
  // The explicit --apply flag is the only path that can execute migrations.
  cliArgs.push('--yes');
  console.log('Applying migrations recorded as pending by Supabase CLI.');
} else {
  cliArgs.push('--dry-run');
  console.log('Dry-run only: remote migration history will be compared; no SQL migrations or Vault settings will be applied.');
}
console.log(`Using Supabase CLI ${CLI_VERSION}; connection details are hidden.`);

const result = spawnSync('npx', cliArgs, {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.error) {
  console.error('Could not start Supabase CLI. Ensure Node.js and npm/npx are installed.');
  process.exit(1);
}
const stdout = redact(result.stdout || '', databaseUrl);
const stderr = redact(result.stderr || '', databaseUrl);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(result.status ?? 1);
