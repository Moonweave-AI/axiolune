#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EXPECTATIONS_PATH,
  buildConstraintInstanceManifest,
} = require('./lib/m2-constraint-instance-builder.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

function parseArgs(argv) {
  const options = { sourceRoot: path.resolve(__dirname, '..', '..') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--source-root', '--expectations', '--output', '--report'].includes(argument)
        || index + 1 >= argv.length) {
      throw new Error(
        'Usage: node build-m2-constraint-instance-manifest.cjs '
          + '[--source-root <repo>] [--expectations <JCS.json>] '
          + '[--output <new-manifest.json>] [--report <new-report.json>]',
      );
    }
    options[{
      '--source-root': 'sourceRoot',
      '--expectations': 'expectationsPath',
      '--output': 'outputPath',
      '--report': 'reportPath',
    }[argument]] = argv[index + 1];
    index += 1;
  }
  return options;
}

function readJcs(filePath) {
  const bytes = fs.readFileSync(filePath);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${filePath}: expected exact UTF-8 RFC 8785 JCS bytes`);
  }
  return value;
}

function writeNew(filePath, bytes) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes, { flag: 'wx' });
}

function diagnosticResult(result) {
  return {
    outcome: result.outcome,
    moduleCount: result.moduleCount,
    instanceCount: result.instanceCount,
    authoredCount: result.authoredCount,
    generatedCount: result.generatedCount,
    manifestBuilt: Boolean(result.bytes),
    releaseClosureOutcome: result.audit?.outcome || 'not-run',
    issues: result.issues,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const expectationsPath = options.expectationsPath
    ? path.resolve(options.expectationsPath)
    : path.join(options.sourceRoot, ...EXPECTATIONS_PATH.split('/'));
  const expectations = fs.existsSync(expectationsPath)
    ? readJcs(expectationsPath)
    : undefined;
  const result = await buildConstraintInstanceManifest({
    sourceRoot: options.sourceRoot,
    expectations,
  });
  const reportBytes = Buffer.from(canonicalJcs(diagnosticResult(result)), 'utf8');
  if (options.reportPath) writeNew(options.reportPath, reportBytes);
  else process.stdout.write(`${reportBytes.toString('utf8')}\n`);

  if (options.outputPath) {
    if (!result.bytes) {
      throw new Error('manifest output refused because normalized-IR expectation closure is incomplete');
    }
    writeNew(options.outputPath, result.bytes);
  }
  process.exitCode = result.outcome === 'built' ? 0 : 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { diagnosticResult, main, parseArgs, readJcs, writeNew };
