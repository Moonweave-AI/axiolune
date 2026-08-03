#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROXY = Object.freeze({ host: '127.0.0.1', port: 3456 });
const PROFILES = Object.freeze([
  Object.freeze({
    id: 'finra-rule-11140-2026-07-31',
    url: 'https://www.finra.org/rules-guidance/rulebooks/finra-rules/11140',
    selector: '.field--name-field-tab-content .field--name-body.field__item',
    output: 'reference/authority-reference/finra/2026-07-31/rule-11140',
  }),
  Object.freeze({
    id: 'finra-notice-00-54-2026-07-31',
    url: 'https://www.finra.org/rules-guidance/notices/00-54',
    selector: 'article.node--type-notices .field--name-body.field__item',
    output: 'reference/authority-reference/finra/2026-07-31/notice-00-54',
  }),
  Object.freeze({
    id: 'investor-gov-ex-dividend-2026-07-31',
    url: 'https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and',
    selector: 'article.node--type-glossary-term',
    output: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend',
  }),
]);

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function request(method, requestPath, body = undefined) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = http.request({
      ...PROXY,
      method,
      path: requestPath,
      headers: bytes === undefined
        ? {}
        : {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': bytes.length,
        },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`CDP proxy ${method} ${requestPath} returned ${res.statusCode}: ${text}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (cause) {
          reject(new Error(`CDP proxy returned invalid JSON: ${cause.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('CDP proxy request timed out')));
    if (bytes !== undefined) req.write(bytes);
    req.end();
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluate(targetId, expression) {
  const response = await request(
    'POST',
    `/eval?target=${encodeURIComponent(targetId)}`,
    expression,
  );
  if (!Object.prototype.hasOwnProperty.call(response, 'value')) {
    throw new Error(`CDP evaluation failed: ${canonicalJcs(response)}`);
  }
  return response.value;
}

async function waitForContent(targetId, profile) {
  const { id, selector } = profile;
  const expression = `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});return {ready:document.readyState,found:Boolean(e),length:e?e.innerText.length:0,title:document.title,url:location.href};})())`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = JSON.parse(await evaluate(targetId, expression));
    // FINRA leaves analytics requests open and may remain "loading" after the
    // authoritative rule body is already complete in the DOM.
    if (state.found && state.length > 100) return state;
    await delay(500);
  }
  throw new Error(`${id} did not expose ${selector} before timeout`);
}

function normalizeText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .normalize('NFC')
    .concat('\n');
}

function verifiedOutputDirectory(relative) {
  const absolute = path.resolve(ROOT, ...relative.split('/'));
  const referenceRoot = `${path.resolve(ROOT, 'reference', 'authority-reference')}${path.sep}`;
  if (!absolute.startsWith(referenceRoot)) {
    throw new Error(`refusing to write outside authority-reference: ${relative}`);
  }
  return absolute;
}

async function capture(profile, capturedAt) {
  const opened = await request('POST', '/new', profile.url);
  const targetId = opened.targetId;
  if (typeof targetId !== 'string' || !/^[A-F0-9]+$/.test(targetId)) {
    throw new Error(`CDP proxy returned an invalid target ID for ${profile.id}`);
  }
  try {
    await waitForContent(targetId, profile);
    const expression = `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(profile.selector)});if(!e)throw new Error('content selector missing');return {title:document.title,finalUrl:location.href,html:e.outerHTML,text:e.innerText};})())`;
    const captured = JSON.parse(await evaluate(targetId, expression));
    if (captured.finalUrl !== profile.url) {
      throw new Error(`${profile.id} redirected to unexpected ${captured.finalUrl}`);
    }
    const htmlBytes = Buffer.from(
      captured.html.replace(/\r\n?/g, '\n').normalize('NFC').concat('\n'),
      'utf8',
    );
    const textBytes = Buffer.from(normalizeText(captured.text), 'utf8');
    const output = verifiedOutputDirectory(profile.output);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'content.html'), htmlBytes);
    fs.writeFileSync(path.join(output, 'content.txt'), textBytes);
    const metadata = {
      schemaVersion: '1.0',
      id: profile.id,
      authorityPageUrl: profile.url,
      finalUrl: captured.finalUrl,
      title: captured.title.normalize('NFC'),
      capturedAt,
      captureMethod: 'Chrome CDP isolated background tab; scoped DOM element serialization',
      contentSelector: profile.selector,
      htmlNormalization: 'CRLF/CR converted to LF; Unicode NFC; one terminal LF',
      textNormalization: 'innerText; CRLF/CR to LF; trim/collapse horizontal whitespace; remove empty lines; Unicode NFC; one terminal LF',
      artifacts: [
        {
          path: 'content.html',
          mediaType: 'text/html',
          byteLength: htmlBytes.length,
          digest: digest(htmlBytes),
        },
        {
          path: 'content.txt',
          mediaType: 'text/plain',
          byteLength: textBytes.length,
          digest: digest(textBytes),
        },
      ],
    };
    fs.writeFileSync(
      path.join(output, 'capture.json'),
      Buffer.from(`${canonicalJcs(metadata)}\n`, 'utf8'),
    );
    return {
      id: profile.id,
      output: profile.output,
      htmlDigest: digest(htmlBytes),
      textDigest: digest(textBytes),
      lineCount: textBytes.toString('utf8').trimEnd().split('\n').length,
    };
  } finally {
    await request('GET', `/close?target=${encodeURIComponent(targetId)}`);
  }
}

async function main() {
  const match = process.argv.slice(2).find((value) => value.startsWith('--captured-at='));
  if (!match) {
    throw new Error(
      '--captured-at is required; authority evidence capture must not derive an authoritative timestamp from the wall clock',
    );
  }
  const capturedAt = match.slice('--captured-at='.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(capturedAt)) {
    throw new Error('--captured-at must be an explicit UTC ISO instant');
  }
  const results = [];
  for (const profile of PROFILES) results.push(await capture(profile, capturedAt));
  process.stdout.write(`${canonicalJcs({ status: 'PASS', capturedAt, results })}\n`);
}

main().catch((cause) => {
  process.stderr.write(`${cause.stack || cause.message}\n`);
  process.exitCode = 1;
});
