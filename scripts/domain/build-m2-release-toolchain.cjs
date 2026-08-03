#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  REGISTRY_PATH,
  buildReleaseToolchainLock,
  parseRegistryBytes,
} = require('./lib/m2-toolchain-lock-builder.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

function parseArgs(argv) {
  const options = { sourceRoot: path.resolve(__dirname, '..', '..') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--source-root', '--registry', '--output', '--report'].includes(argument)
        || index + 1 >= argv.length) {
      throw new Error(
        'Usage: node build-m2-release-toolchain.cjs '
          + '[--source-root <repo>] [--registry <JCS.json>] '
          + '[--output <new-toolchain.lock.json>] [--report <new-report.json>]',
      );
    }
    options[{
      '--source-root': 'sourceRoot',
      '--registry': 'registryPath',
      '--output': 'outputPath',
      '--report': 'reportPath',
    }[argument]] = argv[index + 1];
    index += 1;
  }
  return options;
}

function writeNew(filePath, bytes) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes, { flag: 'wx' });
}

function diagnostic(result) {
  return {
    outcome: result.outcome,
    moduleCount: result.moduleCount,
    customConstraintCount: result.customConstraintCount,
    requiredGateCapabilityCount: result.requiredGateCapabilityCount,
    releaseCheckCapabilityCount: result.releaseCheckCapabilityCount,
    releaseCapabilityCount: result.releaseCapabilityCount,
    componentProfileCoveredCount: result.componentProfileCoveredCount,
    componentProfileUncoveredCount: result.componentProfileUncoveredCount,
    lockBuilt: Boolean(result.bytes),
    missingCapabilityIris: result.missingCapabilityIris,
    issues: result.issues,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const registryPath = options.registryPath
    ? path.resolve(options.registryPath)
    : path.join(options.sourceRoot, ...REGISTRY_PATH.split('/'));
  const registry = fs.existsSync(registryPath)
    ? parseRegistryBytes(fs.readFileSync(registryPath))
    : undefined;
  const result = buildReleaseToolchainLock({
    sourceRoot: options.sourceRoot,
    registry,
  });
  const reportBytes = Buffer.from(canonicalJcs(diagnostic(result)), 'utf8');
  if (options.reportPath) writeNew(options.reportPath, reportBytes);
  else process.stdout.write(`${reportBytes.toString('utf8')}\n`);
  if (options.outputPath) {
    if (!result.bytes) {
      throw new Error('toolchain lock output refused because capability closure is incomplete');
    }
    writeNew(options.outputPath, result.bytes);
  }
  process.exitCode = result.outcome === 'built' ? 0 : 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { diagnostic, main, parseArgs, writeNew };
