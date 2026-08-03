'use strict';

function collectNonFinalStatusMarkers(stdout, stderr, options = {}) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const markers = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:PENDING|SKIPPED?|UNVERIFIED|UNSUPPORTED)(?:\s|:|$)/iu.test(line)) {
      markers.push(`line ${index + 1}: ${line.trim()}`);
      continue;
    }
    const count = /\b(pending(?:-[a-z0-9-]+)?|skipped|todo|warnings?|unverified|unsupported)\s*[:=]\s*([0-9]+)\b/iu.exec(line);
    if (count && Number(count[2]) > 0) {
      markers.push(`line ${index + 1}: ${line.trim()}`);
      continue;
    }
    if (options.tap === true && /#\s*(?:SKIP|TODO)\b/iu.test(line)) {
      markers.push(`line ${index + 1}: ${line.trim()}`);
      continue;
    }
    const tapCount = options.tap === true
      ? /^\s*#\s*(skipped|todo)\s+([0-9]+)\s*$/iu.exec(line)
      : null;
    if (tapCount && Number(tapCount[2]) > 0) {
      markers.push(`line ${index + 1}: ${line.trim()}`);
    }
  }
  return markers;
}

function assertFinalProcessResult(result, label, options = {}) {
  if (!result || result.status !== 0) {
    throw new Error(`${label} failed or remained pending (exit ${String(result?.status)})`);
  }
  const markers = collectNonFinalStatusMarkers(result.stdout, result.stderr, options);
  if (markers.length > 0) {
    throw new Error(`${label} emitted a non-final status: ${markers.slice(0, 5).join(' | ')}`);
  }
}

module.exports = {
  assertFinalProcessResult,
  collectNonFinalStatusMarkers,
};
