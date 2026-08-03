'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clone(value) {
  return structuredClone(value);
}

function materializeYamlMerges(value) {
  if (Array.isArray(value)) return value.map(materializeYamlMerges);
  if (value === null || typeof value !== 'object') return value;
  const merged = {};
  const sources = Array.isArray(value['<<']) ? value['<<'] : [value['<<']];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      Object.assign(merged, materializeYamlMerges(source));
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe YAML key ${key}`);
    if (key !== '<<') merged[key] = materializeYamlMerges(child);
  }
  return merged;
}

function pathTokens(expression) {
  const tokens = [];
  const regex = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/gu;
  let cursor = 0;
  let match;
  while ((match = regex.exec(expression)) !== null) {
    if (match.index !== cursor && expression.slice(cursor, match.index) !== '.') {
      throw new Error(`invalid mutation path ${expression}`);
    }
    const token = match[1] === undefined ? Number(match[2]) : match[1];
    if (typeof token === 'string' && DANGEROUS_KEYS.has(token)) {
      throw new Error(`unsafe mutation path ${expression}`);
    }
    tokens.push(token);
    cursor = regex.lastIndex;
    if (expression[cursor] === '.') cursor += 1;
    regex.lastIndex = cursor;
  }
  if (cursor !== expression.length || tokens.length === 0) {
    throw new Error(`invalid mutation path ${expression}`);
  }
  return tokens;
}

function applyMutation(target, mutation) {
  if (!['set', 'delete'].includes(mutation?.op)) {
    throw new Error(`unsupported mutation ${String(mutation?.op)}`);
  }
  const tokens = pathTokens(mutation.path);
  let parent = target;
  for (const token of tokens.slice(0, -1)) {
    if (parent === null || parent === undefined || !(token in parent)) {
      throw new Error(`mutation path does not resolve: ${mutation.path}`);
    }
    parent = parent[token];
  }
  const finalToken = tokens[tokens.length - 1];
  if (mutation.op === 'delete') {
    if (!(finalToken in parent)) {
      throw new Error(`delete path does not resolve: ${mutation.path}`);
    }
    delete parent[finalToken];
  } else {
    parent[finalToken] = clone(mutation.value);
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

function loadFixture(file, options = {}, stack = []) {
  const rootDirectory = path.resolve(options.rootDirectory || path.dirname(file));
  const resolved = path.resolve(file);
  if (resolved !== rootDirectory && !inside(rootDirectory, resolved)) {
    throw new Error(`fixture escapes directory: ${file}`);
  }
  const realRoot = fs.realpathSync(rootDirectory);
  const realFile = fs.realpathSync(resolved);
  if (realFile !== realRoot && !inside(realRoot, realFile)) {
    throw new Error(`fixture symlink escapes directory: ${file}`);
  }
  if (stack.includes(realFile)) {
    throw new Error(`cyclic fixture inheritance: ${[...stack, realFile].join(' -> ')}`);
  }
  const document = materializeYamlMerges(yaml.load(fs.readFileSync(realFile, 'utf8')));
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`fixture root must be an object: ${file}`);
  }
  if (!document.extends) return document;
  if (typeof document.extends !== 'string' || path.isAbsolute(document.extends)) {
    throw new Error(`fixture extends must be a relative path: ${file}`);
  }
  const base = clone(loadFixture(
    path.resolve(path.dirname(realFile), document.extends),
    { rootDirectory },
    [...stack, realFile],
  ));
  for (const mutation of document.mutations || []) applyMutation(base, mutation);
  base.caseId = document.caseId;
  base.expected = document.expected;
  delete base.extends;
  delete base.mutations;
  return base;
}

module.exports = {
  applyMutation,
  loadFixture,
  materializeYamlMerges,
  pathTokens,
};
