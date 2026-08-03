'use strict';

const EXPECTED_COUNTS = Object.freeze({
  moduleCount: 10,
  entryCount: 10678,
  authoredInstanceCount: 676,
  generatedCount: 10002,
  authoredConstraintCount: 173,
  authoredBindingCount: 580,
  shaclInstanceCount: 10521,
  customInstanceCount: 157,
  shaclCaseExecutionCount: 21042,
});

const SHACL_RUN_ROUND = 8;
const CUSTOM_RUN_ROUND = 4;
const CONSTRAINT_GATE_ROUND = 2;

const SHACL_RUN_MANIFEST_PATH =
  `docs/domain/infrastructure/shacl-instance-runs/round-${SHACL_RUN_ROUND}/run-manifest.json`;
const CUSTOM_EVIDENCE_PATH =
  `docs/domain/infrastructure/custom-release-capability-runs/round-${CUSTOM_RUN_ROUND}/custom-release-capability-evidence.json`;
const CUSTOM_EVIDENCE_MANIFEST_PATH =
  `docs/domain/infrastructure/custom-release-capability-runs/round-${CUSTOM_RUN_ROUND}/manifest.json`;
const CONSTRAINT_GATE_ROOT =
  `docs/domain/infrastructure/constraint-instance-runs/round-${CONSTRAINT_GATE_ROUND}`;
const CONSTRAINT_GATE_PATHS = Object.freeze({
  customPositive: `${CONSTRAINT_GATE_ROOT}/custom-positive-expectations.json`,
  customNegative: `${CONSTRAINT_GATE_ROOT}/custom-negative-expectations.json`,
  discovery: `${CONSTRAINT_GATE_ROOT}/shacl-execution.discovery.json`,
  subjectInventory: `${CONSTRAINT_GATE_ROOT}/shacl-execution.subject-inventory.json`,
  report: `${CONSTRAINT_GATE_ROOT}/shacl-execution.validation-report.json`,
  sourceEvidence: `${CONSTRAINT_GATE_ROOT}/source-evidence.json`,
});

function assertCountBalance(counts = EXPECTED_COUNTS) {
  if (counts.entryCount !== counts.authoredInstanceCount + counts.generatedCount) {
    throw new Error('constraint-instance authored/generated counts do not sum to total');
  }
  if (counts.entryCount !== counts.shaclInstanceCount + counts.customInstanceCount) {
    throw new Error('constraint-instance SHACL/Custom counts do not sum to total');
  }
  if (counts.shaclCaseExecutionCount !== counts.shaclInstanceCount * 2) {
    throw new Error('SHACL positive/negative case count is not exactly twice SHACL instances');
  }
  return true;
}

assertCountBalance();

module.exports = {
  CONSTRAINT_GATE_PATHS,
  CONSTRAINT_GATE_ROOT,
  CONSTRAINT_GATE_ROUND,
  CUSTOM_EVIDENCE_MANIFEST_PATH,
  CUSTOM_EVIDENCE_PATH,
  CUSTOM_RUN_ROUND,
  EXPECTED_COUNTS,
  SHACL_RUN_MANIFEST_PATH,
  SHACL_RUN_ROUND,
  assertCountBalance,
};
