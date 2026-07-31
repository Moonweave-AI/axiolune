#!/usr/bin/env node
/**
 * Recompute references.lock digests from local evidence files under reference/.
 * Paywalled / remote-only sources get explicit unavailable digests (not sha256:000…).
 *
 * Round-6: FIBO digest now content-addresses ALL *.rdf files (295 ontology artifacts),
 * not just the 6 documentation/evidence files. This makes the digest reproducible and
 * upgrade-detectable against the full ontology bundle.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');

function hashFiles(relPaths) {
  const h = crypto.createHash('sha256');
  const sorted = [...relPaths].sort();
  for (const rel of sorted) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('missing evidence file: ' + rel);
    h.update(rel + '\n');
    h.update(fs.readFileSync(abs));
    h.update('\n');
  }
  return 'sha256:' + h.digest('hex');
}

// Content-address ALL *.rdf files under a directory (for FIBO ontology bundle)
function hashAllRdf(dirRel) {
  const h = crypto.createHash('sha256');
  const files = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else if (n.endsWith('.rdf')) files.push(p);
    }
  })(path.join(ROOT, dirRel));
  files.sort();
  for (const f of files) h.update(fs.readFileSync(f));
  return 'sha256:' + h.digest('hex');
}

const references = [
  {
    id: 'fibo-local-evidence',
    authority: 'EDM Council / OMG',
    releaseOrCommit: 'master-checkout (latest observed versionIRI 20260701; no formal git tag — no .git present)',
    pinnedVersionIRI: 'https://spec.edmcouncil.org/fibo/ontology/20260701',
    artifactUrl: 'https://github.com/edmcouncil/fibo',
    license: 'MIT',
    retrievalDate: '2026-07-30',
    maturity: 'local-evidence-bundle-rdf',
    importPolicy: 'linked-data-alignment',
    note: 'FinRegOnt/Axiolune policy: do NOT owl:imports AboutFIBO wholesale in development. Use ext-fibo-release-* adapter when formal import is required. Digest below is over all 295 RDF ontology files (owl:versionIRI-bearing), not just the 6 documentation/evidence files listed; see evidenceFiles for human-readable subset.',
    localPath: 'reference/ontology-design-reference/fibo/',
    evidenceFiles: [
      'reference/ontology-design-reference/fibo/ONTOLOGY_GUIDE.md',
      'reference/ontology-design-reference/fibo/CONTRIBUTING.md',
      'reference/ontology-design-reference/fibo/SEC/Securities/SecuritiesListings.rdf',
      'reference/ontology-design-reference/fibo/SEC/Securities/SecuritiesIssuance.rdf',
      'reference/ontology-design-reference/fibo/FBC/FinancialInstruments/FinancialInstruments.rdf',
      'reference/ontology-design-reference/fibo/FBC/FinancialInstruments/InstrumentPricing.rdf',
    ],
    artifactDigestScope: 'all 295 *.rdf files under localPath (content-addressed ontology bundle, sorted by path)',
    _digestFn: 'hashAllRdf',
  },
  {
    id: 'finregont-fibo-import-pattern',
    authority: 'FinRegOnt',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/edmcouncil (pattern reference)',
    license: 'see local tree',
    retrievalDate: '2026-07-30',
    note: 'Documents conditional FIBO import swap: ALL for development vs harness for production. Axiolune follows selective alignment, not ALL import.',
    localPath: 'reference/ontology-design-reference/FinRegOnt/',
    evidenceFiles: [
      'reference/ontology-design-reference/FinRegOnt/ref/FIBO_import.ttl',
    ],
  },
  {
    id: 'bian-payment-order-sample',
    authority: 'BIAN',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://bian.org/',
    license: 'see BIAN terms',
    retrievalDate: '2026-07-30',
    note: 'Service-domain CSV sample (PaymentOrder) for banking service taxonomy reference-only.',
    localPath: 'reference/ontology-design-reference/BIAN/PaymentOrder/',
    evidenceFiles: [
      'reference/ontology-design-reference/BIAN/PaymentOrder/PaymentOrderServiceOperations.csv',
      'reference/ontology-design-reference/BIAN/PaymentOrder/PaymentOrderSpecification.csv',
    ],
  },
  {
    id: 'iso-6166',
    authority: 'ISO',
    releaseOrCommit: 'ISO 6166:2021',
    artifactUrl: 'https://www.iso.org/standard/78502.html',
    artifactDigest: 'sha256:unavailable-paywalled',
    license: 'ISO Copyright (paywalled)',
    retrievalDate: '2026-07-30',
    note: 'ISIN; definition evidenced via FIBO SEC/SecuritiesIdentification + local fibo RDF. Digest unavailable until licensed artifact stored.',
  },
  {
    id: 'iso-10383',
    authority: 'ISO',
    releaseOrCommit: 'ISO 10383:2012',
    artifactUrl: 'https://www.iso.org/obp/ui/en/',
    artifactDigest: 'sha256:unavailable-paywalled',
    license: 'ISO Copyright (paywalled)',
    retrievalDate: '2026-07-30',
    note: 'MIC; evidenced via FIBO FBC/Markets.',
  },
  {
    id: 'iso-17442',
    authority: 'ISO / GLEIF',
    releaseOrCommit: 'ISO 17442:2020',
    artifactUrl: 'https://www.iso.org/standard/78829.html',
    artifactDigest: 'sha256:unavailable-paywalled',
    license: 'ISO Copyright (paywalled)',
    retrievalDate: '2026-07-30',
    note: 'LEI; evidenced via FIBO BE/LEIEntities + GLEIF public materials.',
  },
  {
    id: 'iso-10962',
    authority: 'ISO',
    releaseOrCommit: 'ISO 10962:2021',
    artifactUrl: 'https://www.iso.org/standard/73690.html',
    artifactDigest: 'sha256:unavailable-paywalled',
    license: 'ISO Copyright (paywalled)',
    retrievalDate: '2026-07-30',
    note: 'CFI classification.',
  },
  {
    id: 'nautilus-trader',
    authority: 'Nautech Systems',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/nautechsystems/nautilus_trader',
    license: 'LGPL-3.0',
    retrievalDate: '2026-07-30',
    note: 'OrderStatus includes PendingUpdate/PendingCancel; OrderEventAny is event-log model. Implementation evidence only.',
    localPath: 'reference/project-reference/nautilus_trader/',
    evidenceFiles: [
      'reference/project-reference/nautilus_trader/crates/model/src/enums.rs',
      'reference/project-reference/nautilus_trader/crates/model/src/events/order/any.rs',
    ],
  },
  {
    id: 'lean',
    authority: 'QuantConnect',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/QuantConnect/Lean',
    license: 'Apache-2.0',
    retrievalDate: '2026-07-30',
    note: 'OrderStatus has CancelPending/UpdateSubmitted; OrderEvent carries Status. Implementation evidence only.',
    localPath: 'reference/project-reference/Lean/',
    evidenceFiles: [
      'reference/project-reference/Lean/Common/Orders/OrderTypes.cs',
      'reference/project-reference/Lean/Common/Orders/OrderEvent.cs',
    ],
  },
  {
    id: 'qlib',
    authority: 'Microsoft',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/microsoft/qlib',
    license: 'MIT',
    retrievalDate: '2026-07-30',
    note: 'PIT is (publication date, period, value, _next) revision chain — distinct from market-data three-axis bar PIT. Informs FactorObservation design.',
    localPath: 'reference/project-reference/qlib/',
    evidenceFiles: [
      'reference/project-reference/qlib/docs/advanced/PIT.rst',
      'reference/project-reference/qlib/qlib/data/data.py',
      'reference/project-reference/qlib/qlib/utils/__init__.py',
    ],
  },
  {
    id: 'rqalpha',
    authority: 'Ricequant',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/ricequant/rqalpha',
    license: 'Apache-2.0 (non-commercial clause — check)',
    retrievalDate: '2026-07-30',
    note: 'stock_t1 / price_limits / close_today are runtime behaviors → model as RuleApplicability facts, not static venue attributes.',
    localPath: 'reference/project-reference/rqalpha/',
    evidenceFiles: [
      'reference/project-reference/rqalpha/rqalpha/mod/rqalpha_mod_sys_accounts/__init__.py',
      'reference/project-reference/rqalpha/rqalpha/utils/price_limits.py',
      'reference/project-reference/rqalpha/rqalpha/portfolio/position.py',
    ],
  },
  {
    id: 'vnpy',
    authority: 'vn.py',
    releaseOrCommit: 'local-checkout',
    artifactUrl: 'https://github.com/vnpy/vnpy',
    license: 'MIT',
    retrievalDate: '2026-07-30',
    note: 'Offset.CLOSETODAY + SHFE/INE split; backtest limit-up/down. RuleApplicability evidence.',
    localPath: 'reference/project-reference/vnpy/',
    evidenceFiles: [
      'reference/project-reference/vnpy/vnpy/trader/constant.py',
      'reference/project-reference/vnpy/vnpy/trader/converter.py',
    ],
  },
];

for (const ref of references) {
  if (ref._digestFn === 'hashAllRdf' && ref.localPath) {
    ref.artifactDigest = hashAllRdf(ref.localPath);
    delete ref._digestFn;
    console.log(ref.id, ref.artifactDigest, '(all RDF)');
  } else if (ref.evidenceFiles) {
    ref.artifactDigest = hashFiles(ref.evidenceFiles);
    console.log(ref.id, ref.artifactDigest);
  } else {
    console.log(ref.id, ref.artifactDigest);
  }
}

const doc = {
  lockVersion: '0.3.0',
  updated: '2026-07-31',
  note: 'Round-6: FIBO pinned to observed latest versionIRI date 20260701 (master checkout, not a formal git tag — no .git present). Digest is content-addressed over all 295 RDF ontology artifacts (not documentation), making it reproducible and upgrade-detectable. Zero digests prohibited; paywalled ISO uses sha256:unavailable-paywalled; local evidence uses SHA-256 over listed evidenceFiles.',
  references,
};

fs.mkdirSync(path.dirname(LOCK), { recursive: true });
fs.writeFileSync(LOCK, yaml.dump(doc, { lineWidth: 120, noRefs: true }));
console.log('\n✓ wrote', path.relative(ROOT, LOCK));
