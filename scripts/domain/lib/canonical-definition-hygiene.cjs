'use strict';

const IMPLEMENTATION_NAMES = Object.freeze([
  ['FinRL-Trading', /\bFinRL-Trading\b/iu],
  ['FinRL', /\bFinRL\b/iu],
  ['freqtrade', /\bfreqtrade\b/iu],
  ['Lean', /\bLean\b/iu],
  ['lumibot', /\blumibot\b/iu],
  ['nautilus_trader', /\bnautilus_trader\b/iu],
  ['Nautilus', /\bNautilus\b/iu],
  ['pyfolio', /\bpyfolio\b/iu],
  ['qlib', /\bqlib\b/iu],
  ['quantstats', /\bquantstats\b/iu],
  ['RD-Agent', /\bRD-Agent\b/iu],
  ['rqalpha', /\brqalpha\b/iu],
  ['ta4j', /\bta4j\b/iu],
  ['vectorbt', /\bvectorbt\b/iu],
  ['vnpy', /\bvnpy\b/iu],
  ['backtrader', /\bbacktrader\b/iu],
  ['zipline', /\bzipline\b/iu],
]);

function validateCanonicalDefinitions(document) {
  const findings = [];

  function visit(value, location) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (key === 'definition' && typeof child === 'string') {
        for (const [implementation, pattern] of IMPLEMENTATION_NAMES) {
          if (pattern.test(child)) {
            findings.push({
              code: 'PROJECT_IMPLEMENTATION_NAME_IN_CANONICAL_DEFINITION',
              implementation,
              location: childLocation,
            });
          }
        }
      } else {
        visit(child, childLocation);
      }
    }
  }

  visit(document && document.domain, 'domain');
  return findings;
}

function validateTerminologyHygiene(document) {
  const findings = [];
  const cards = Array.isArray(document && document.cards) ? document.cards : [];

  function visit(value, location, term) {
    if (typeof value === 'string') {
      if (/\bMIC\b[^\r\n]*\b4\s*\+\s*4\b|\b4\s*\+\s*4\b[^\r\n]*\bMIC\b/iu.test(value)) {
        findings.push({
          code: 'LEGACY_CONCATENATED_MIC_MODEL',
          term,
          location,
        });
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${location}[${index}]`, term));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${location}.${key}`, term);
    }
  }

  cards.forEach((card, index) => {
    const term = card && typeof card.term === 'string' ? card.term : `card[${index}]`;
    visit(card, `cards[${index}]`, term);
  });
  return findings;
}

module.exports = {
  IMPLEMENTATION_NAMES,
  validateCanonicalDefinitions,
  validateTerminologyHygiene,
};
