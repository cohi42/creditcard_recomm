const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(__dirname, 'enrich_cafe_benefits_with_notices.js');
const ETC_CATEGORY = '\uAE30\uD0C0';

function hasOption(args, optionName) {
  return args.includes(optionName);
}

function buildArgs(userArgs) {
  const args = [SCRIPT_PATH, '--notice-category', ETC_CATEGORY];

  if (!hasOption(userArgs, '--source-db') && !hasOption(userArgs, '--db')) {
    args.push('--source-db', path.resolve(__dirname, '..', 'cafe_v2.db'));
  }
  if (!hasOption(userArgs, '--output-db')) {
    args.push('--output-db', path.resolve(__dirname, '..', 'cafe_v3.db'));
  }
  if (!hasOption(userArgs, '--log')) {
    args.push('--log', path.resolve(__dirname, 'etc_enrichment_log.json'));
  }
  if (!hasOption(userArgs, '--debug-dir')) {
    args.push('--debug-dir', path.resolve(__dirname, 'etc_enrichment_debug'));
  }

  args.push(...userArgs);
  return args;
}

const result = spawnSync(process.execPath, buildArgs(process.argv.slice(2)), {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
