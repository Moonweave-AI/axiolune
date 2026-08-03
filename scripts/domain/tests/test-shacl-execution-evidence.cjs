'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeShaclExecution } = require('../lib/shacl-execution-evidence.cjs');

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const expected = {
  component: `${SH}MinCountConstraintComponent`,
  focus: 'https://axiolune.ai/data/test/focus',
  path: 'https://axiolune.ai/ontology/test/path',
  severity: `${SH}Violation`,
  sourceShape: 'https://axiolune.ai/ontology/test/shape',
};

function report(conforms, results = []) {
  const lines = [
    `_:report <${RDF}type> <${SH}ValidationReport> .`,
    `_:report <${SH}conforms> "${conforms}"^^<${XSD}boolean> .`,
  ];
  results.forEach((result, index) => {
    const subject = `_:result${index}`;
    lines.push(`_:report <${SH}result> ${subject} .`);
    lines.push(`${subject} <${RDF}type> <${SH}ValidationResult> .`);
    lines.push(`${subject} <${SH}sourceConstraintComponent> <${result.component}> .`);
    lines.push(`${subject} <${SH}focusNode> <${result.focus}> .`);
    if (result.path) lines.push(`${subject} <${SH}resultPath> <${result.path}> .`);
    lines.push(`${subject} <${SH}resultSeverity> <${result.severity}> .`);
    lines.push(`${subject} <${SH}sourceShape> <${result.sourceShape}> .`);
  });
  return `${lines.join('\n')}\n`;
}

test('engine exit 2 can never satisfy a rejected fixture', () => {
  const result = analyzeShaclExecution(
    { status: 2, stdout: report('false', [expected]), stderr: 'runtime failure' },
    'rejected',
    expected,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'engine-runtime-failure');
});

test('component/focus/path/severity must occur on the same validation result', () => {
  const result = analyzeShaclExecution(
    {
      status: 1,
      stdout: report('false', [
        { ...expected, path: 'https://axiolune.ai/ontology/test/other-path' },
        { ...expected, component: `${SH}MaxCountConstraintComponent` },
      ]),
    },
    'rejected',
    expected,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'validation-result-set-mismatch');
});

test('one exact structured violation is accepted', () => {
  const result = analyzeShaclExecution(
    { status: 1, stdout: report('false', [expected]) },
    'rejected',
    expected,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.matchedViolation, expected);
});

test('an extra distinct validation result fails the exact result-set contract', () => {
  const result = analyzeShaclExecution(
    {
      status: 1,
      stdout: report('false', [
        expected,
        {
          ...expected,
          component: `${SH}MaxCountConstraintComponent`,
        },
      ]),
    },
    'rejected',
    expected,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'validation-result-set-mismatch');
  assert.equal(result.resultCount, 2);
});

test('an orphan typed result fails report-result closure', () => {
  const stdout = report('false', [expected])
    .replace(`_:report <${SH}result> _:result0 .\n`, '');
  const result = analyzeShaclExecution(
    { status: 1, stdout },
    'rejected',
    expected,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-validation-report');
});

test('nested sh:detail results form part of the exact normalized result multiset', () => {
  const wrapper = {
    component: `${SH}NodeConstraintComponent`,
    focus: expected.focus,
    severity: `${SH}Violation`,
    sourceShape: 'https://axiolune.ai/ontology/test/wrapper-shape',
  };
  const lines = report('false', [wrapper, expected])
    .replace(`_:report <${SH}result> _:result1 .\n`, '')
    .concat(`_:result0 <${SH}detail> _:result1 .\n`);
  const accepted = analyzeShaclExecution(
    { status: 1, stdout: lines },
    'rejected',
    [wrapper, expected],
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.matchedViolations.length, 2);
});

test('otherwise identical results must be distinguished by exact sourceShape', () => {
  const second = {
    ...expected,
    sourceShape: 'https://axiolune.ai/ontology/test/second-shape',
  };
  const stdout = report('false', [expected, second]);
  const singleton = analyzeShaclExecution(
    { status: 1, stdout },
    'rejected',
    expected,
  );
  assert.equal(singleton.ok, false);
  const exactMultiplicity = analyzeShaclExecution(
    { status: 1, stdout },
    'rejected',
    [expected, second],
  );
  assert.equal(exactMultiplicity.ok, true);
  const ambiguousExpectation = analyzeShaclExecution(
    { status: 1, stdout },
    'rejected',
    [
      {
        component: expected.component,
        focus: expected.focus,
        path: expected.path,
        severity: expected.severity,
      },
      {
        component: expected.component,
        focus: expected.focus,
        path: expected.path,
        severity: expected.severity,
      },
    ],
  );
  assert.equal(ambiguousExpectation.ok, false);
  assert.equal(ambiguousExpectation.reason, 'invalid-expected-violation');
  const exactDuplicateMultiplicity = analyzeShaclExecution(
    { status: 1, stdout: report('false', [expected, expected]) },
    'rejected',
    [expected, expected],
  );
  assert.equal(exactDuplicateMultiplicity.ok, true);
});

test('accepted fixture requires exit 0, conforms true, and zero results', () => {
  const accepted = analyzeShaclExecution(
    { status: 0, stdout: report('true') },
    'accepted',
  );
  assert.equal(accepted.ok, true);
  const malformedAcceptance = analyzeShaclExecution(
    { status: 0, stdout: report('false', [expected]) },
    'accepted',
  );
  assert.equal(malformedAcceptance.ok, false);
});
