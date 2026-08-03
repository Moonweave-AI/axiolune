'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_PATHS = Object.freeze({
  m2Plan: 'docs/domain/planning/M2-PLAN.md',
  rfc: 'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md',
  domainDecisions: 'docs/domain/decisions',
  metaDecisions: 'docs/meta/decisions',
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function statusHeader(text) {
  const header = String(text).split(/\r?\n/u).slice(0, 40).join('\n');
  const match = /^\s*\*\*(?:Status|状态)\*\*\s*[:：]\s*([^\r\n]+)/imu.exec(header);
  return match ? match[1].trim() : '';
}

function isAccepted(status) {
  return /^(?:Accepted(?:\s|\(|$)|已接受(?:\s|（|\(|$))/iu.test(status);
}

function isSuperseded(status) {
  return /(?:^|\s)(?:Superseded|Replaced)(?:\s|\(|$)|已(?:被)?(?:取代|废止|替代)/iu.test(status);
}

function listDecisionFiles(root, relativeDirectory, number) {
  const directory = path.join(root, ...relativeDirectory.split('/'));
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) return [];
  const pattern = new RegExp(`^ADR-${number}(?:[-_.].*)?\\.md$`, 'iu');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => toPosix(path.join(relativeDirectory, entry.name)))
    .sort(compareUtf8);
}

function readText(root, relativePath, issues, missingCode) {
  const absolute = path.join(root, ...relativePath.split('/'));
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
    issues.push({
      code: missingCode,
      path: relativePath,
      message: `missing required governance artifact ${relativePath}`,
    });
    return null;
  }
  return fs.readFileSync(absolute, 'utf8');
}

function auditM2GovernanceBaseline(root) {
  const repositoryRoot = path.resolve(root);
  const issues = [];
  const checks = [];

  function fail(code, relativePath, message) {
    issues.push({ code, path: relativePath, message });
  }

  function check(checkId, passed, relativePath, detail) {
    checks.push({ checkId, passed, path: relativePath, detail });
  }

  const rfc = readText(
    repositoryRoot,
    REQUIRED_PATHS.rfc,
    issues,
    'M2_GOV_RFC001_MISSING',
  );
  if (rfc !== null) {
    const status = statusHeader(rfc);
    const passed = isAccepted(status);
    check('rfc-001-accepted', passed, REQUIRED_PATHS.rfc, status || 'missing status header');
    if (!passed) {
      fail(
        'M2_GOV_RFC001_NOT_ACCEPTED',
        REQUIRED_PATHS.rfc,
        `RFC-001 must be Accepted before v0.3 release evidence is eligible; observed ${status || 'no status'}`,
      );
    }
  }

  const metaAdrFiles = listDecisionFiles(repositoryRoot, REQUIRED_PATHS.metaDecisions, '013');
  if (metaAdrFiles.length !== 1) {
    check(
      'meta-adr-013-singleton',
      false,
      REQUIRED_PATHS.metaDecisions,
      `discovered ${metaAdrFiles.length}`,
    );
    fail(
      metaAdrFiles.length === 0 ? 'M2_GOV_META_ADR013_MISSING' : 'M2_GOV_META_ADR013_AMBIGUOUS',
      REQUIRED_PATHS.metaDecisions,
      `expected exactly one M3 v0.6.0 ADR-013; discovered ${metaAdrFiles.length}`,
    );
  } else {
    const relativePath = metaAdrFiles[0];
    const text = readText(repositoryRoot, relativePath, issues, 'M2_GOV_META_ADR013_MISSING');
    const status = statusHeader(text || '');
    const accepted = isAccepted(status);
    const versioned = /\bM3\s+v0\.6\.0\b/iu.test(text || '');
    check('meta-adr-013-accepted', accepted, relativePath, status || 'missing status header');
    check('meta-adr-013-v0.6.0', versioned, relativePath, versioned ? 'M3 v0.6.0' : 'missing M3 v0.6.0');
    if (!accepted) {
      fail(
        'M2_GOV_META_ADR013_NOT_ACCEPTED',
        relativePath,
        `Meta ADR-013 must be Accepted; observed ${status || 'no status'}`,
      );
    }
    if (!versioned) {
      fail(
        'M2_GOV_META_ADR013_WRONG_BASELINE',
        relativePath,
        'Meta ADR-013 does not bind the breaking M3 v0.6.0 prerequisite',
      );
    }
  }

  const domainAdr13Files = listDecisionFiles(repositoryRoot, REQUIRED_PATHS.domainDecisions, '013');
  if (domainAdr13Files.length !== 1) {
    check(
      'domain-adr-013-singleton',
      false,
      REQUIRED_PATHS.domainDecisions,
      `discovered ${domainAdr13Files.length}`,
    );
    fail(
      domainAdr13Files.length === 0
        ? 'M2_GOV_DOMAIN_ADR013_MISSING'
        : 'M2_GOV_DOMAIN_ADR013_AMBIGUOUS',
      REQUIRED_PATHS.domainDecisions,
      `expected exactly one historical domain ADR-013; discovered ${domainAdr13Files.length}`,
    );
  } else {
    const relativePath = domainAdr13Files[0];
    const text = readText(repositoryRoot, relativePath, issues, 'M2_GOV_DOMAIN_ADR013_MISSING');
    const status = statusHeader(text || '');
    const superseded = isSuperseded(status);
    check('domain-adr-013-superseded', superseded, relativePath, status || 'missing status header');
    if (!superseded) {
      fail(
        'M2_GOV_DOMAIN_ADR013_NOT_SUPERSEDED',
        relativePath,
        `the inferred-type ADR-013 must be Superseded after RFC-001 acceptance; observed ${status || 'no status'}`,
      );
    }
  }

  const domainAdr16Files = listDecisionFiles(repositoryRoot, REQUIRED_PATHS.domainDecisions, '016');
  if (domainAdr16Files.length !== 1) {
    check(
      'domain-adr-016-singleton',
      false,
      REQUIRED_PATHS.domainDecisions,
      `discovered ${domainAdr16Files.length}`,
    );
    fail(
      domainAdr16Files.length === 0
        ? 'M2_GOV_DOMAIN_ADR016_MISSING'
        : 'M2_GOV_DOMAIN_ADR016_AMBIGUOUS',
      REQUIRED_PATHS.domainDecisions,
      `expected exactly one typed-container domain ADR-016; discovered ${domainAdr16Files.length}`,
    );
  } else {
    const relativePath = domainAdr16Files[0];
    const text = readText(repositoryRoot, relativePath, issues, 'M2_GOV_DOMAIN_ADR016_MISSING');
    const status = statusHeader(text || '');
    const accepted = isAccepted(status);
    const bindsRfc = /\bRFC-001\b/u.test(text || '');
    const typedContainer = /typed[- ]container|类型化容器/iu.test(text || '');
    check('domain-adr-016-accepted', accepted, relativePath, status || 'missing status header');
    check(
      'domain-adr-016-contract',
      bindsRfc && typedContainer,
      relativePath,
      `RFC-001=${bindsRfc}; typed-container=${typedContainer}`,
    );
    if (!accepted) {
      fail(
        'M2_GOV_DOMAIN_ADR016_NOT_ACCEPTED',
        relativePath,
        `Domain ADR-016 must be Accepted; observed ${status || 'no status'}`,
      );
    }
    if (!bindsRfc || !typedContainer) {
      fail(
        'M2_GOV_DOMAIN_ADR016_CONTRACT_MISMATCH',
        relativePath,
        'Domain ADR-016 must bind RFC-001 and the strict typed-container authoring profile',
      );
    }
  }

  const plan = readText(
    repositoryRoot,
    REQUIRED_PATHS.m2Plan,
    issues,
    'M2_GOV_M2_PLAN_MISSING',
  );
  if (plan !== null) {
    const status = statusHeader(plan);
    const accepted = isAccepted(status);
    const header = plan.split(/\r?\n/u).slice(0, 20).join('\n');
    const headerBaseline = /\bM3\s+v0\.6\.0\b/iu.test(header)
      && !/\bM3\s+v0\.5\.1\b/iu.test(header);
    const e0Lines = plan.split(/\r?\n/u).filter(
      (line) => /^\s*\|\s*E0(?:\s|：|:|\|)/iu.test(line),
    );
    const e0Baseline = e0Lines.length === 1
      && /\bM3\s+v0\.6\.0\b/iu.test(e0Lines[0])
      && !/\bM3\s+v0\.5\.1\b/iu.test(e0Lines[0]);
    const bindsRfc = /\bRFC-001\b/u.test(plan);
    check('m2-plan-accepted', accepted, REQUIRED_PATHS.m2Plan, status || 'missing status header');
    check('m2-plan-header-v0.6.0', headerBaseline, REQUIRED_PATHS.m2Plan, headerBaseline ? 'M3 v0.6.0' : 'stale or missing baseline');
    check('m2-plan-e0-v0.6.0', e0Baseline, REQUIRED_PATHS.m2Plan, `matching E0 rows=${e0Lines.length}`);
    check('m2-plan-rfc-001', bindsRfc, REQUIRED_PATHS.m2Plan, bindsRfc ? 'RFC-001 bound' : 'RFC-001 absent');
    if (!accepted) {
      fail(
        'M2_GOV_M2_PLAN_NOT_ACCEPTED',
        REQUIRED_PATHS.m2Plan,
        `M2-PLAN must be Accepted in the RFC decision transaction; observed ${status || 'no status'}`,
      );
    }
    if (!headerBaseline) {
      fail(
        'M2_GOV_M2_PLAN_HEADER_BASELINE_DRIFT',
        REQUIRED_PATHS.m2Plan,
        'M2-PLAN header must bind M3 v0.6.0 and must not retain the v0.5.1 prerequisite',
      );
    }
    if (!e0Baseline) {
      fail(
        'M2_GOV_M2_PLAN_E0_BASELINE_DRIFT',
        REQUIRED_PATHS.m2Plan,
        'M2-PLAN must contain exactly one E0 row bound to M3 v0.6.0, with no v0.5.1 prerequisite',
      );
    }
    if (!bindsRfc) {
      fail(
        'M2_GOV_M2_PLAN_RFC001_UNBOUND',
        REQUIRED_PATHS.m2Plan,
        'M2-PLAN does not bind the accepted RFC-001 conformance profile',
      );
    }
  }

  issues.sort((left, right) => {
    for (const field of ['code', 'path', 'message']) {
      const comparison = compareUtf8(left[field], right[field]);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  checks.sort((left, right) => compareUtf8(left.checkId, right.checkId));
  return {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0/governance-prerequisites',
    outcome: issues.length === 0 ? 'passed' : 'failed',
    checks,
    issues,
  };
}

module.exports = {
  REQUIRED_PATHS,
  auditM2GovernanceBaseline,
  isAccepted,
  isSuperseded,
  statusHeader,
};
