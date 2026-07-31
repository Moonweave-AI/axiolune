#!/usr/bin/env node
/**
 * Rewrite fixture YAML: wrap bare decimals on Money/Quantity attributes into structured objects.
 * Round-5 P0 — closes "禁裸 decimal vs 空 Money + 裸数 fixture" contradiction.
 *
 * Usage: node scripts/domain/rewrite-fixtures-structured-money.cjs
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'm2', 'fixtures');

const MONEY = new Set([
  'hasLimitPrice', 'hasStopPrice', 'hasExecutionPrice', 'hasCommission',
  'hasPriceValue', 'hasBidPrice', 'hasAskPrice', 'hasOpenPrice', 'hasHighPrice',
  'hasLowPrice', 'hasClosePrice', 'hasTickSize', 'hasMarketValue', 'hasCostBasis',
  'hasUnrealizedPnL', 'hasNotional', 'hasInitialCapital', 'hasPaymentAmount',
]);
const QTY = new Set([
  'hasOrderQuantity', 'hasExecutionQuantity', 'hasQuantity', 'hasFactorValue',
  'hasCumulativeReturn', 'hasMaxDrawdown', 'hasSharpeRatio', 'hasSignalStrength',
  'hasRuleParameterValue', 'hasLotSize', 'hasVolume',
]);

function isBare(v) {
  if (typeof v === 'number') return true;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return true;
  return false;
}

function money(v, currency = 'USD') {
  return {
    type: 'MonetaryAmount',
    hasNumericAmount: String(v),
    hasCurrencyCode: currency,
  };
}

function qty(v, unit = 'share') {
  return {
    type: 'QuantityValue',
    hasNumericAmount: String(v),
    hasUnitCode: unit,
  };
}

function unitFor(key) {
  if (/Return|Drawdown|Sharpe|Strength|Parameter/.test(key)) return 'ratio';
  if (/Volume/.test(key)) return 'share';
  return 'share';
}

function rewriteNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    let c = false;
    for (const x of node) if (rewriteNode(x)) c = true;
    return c;
  }
  let changed = false;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.type === 'MonetaryAmount' || v.type === 'QuantityValue')) {
      continue;
    }
    if (MONEY.has(k) && isBare(v)) {
      node[k] = money(v, node.hasCurrencyCode || node.hasCurrency || 'USD');
      changed = true;
    } else if (QTY.has(k) && isBare(v)) {
      node[k] = qty(v, unitFor(k));
      changed = true;
    } else if (v && typeof v === 'object') {
      if (rewriteNode(v)) changed = true;
    }
  }
  // OrderIntent: ensure instrument role
  if (
    (node.type === 'https://axiolune.ai/ontology/finance/orders-execution/OrderIntent' ||
      (typeof node.iri === 'string' && node.iri.includes('order-intent'))) &&
    !node.intentsInstrument &&
    node.hasOrderSide
  ) {
    node.intentsInstrument = 'https://axiolune.ai/data/test/instrument-AAPL';
    changed = true;
  }
  return changed;
}

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.yaml')) {
      const raw = fs.readFileSync(p, 'utf8');
      const doc = yaml.load(raw);
      if (!doc || !doc.fixtures) continue;
      let changed = false;
      for (const fx of doc.fixtures) {
        if (rewriteNode(fx)) changed = true;
        if (fx.instance && rewriteNode(fx.instance)) changed = true;
        if (fx.instances && rewriteNode(fx.instances)) changed = true;
      }
      if (changed) {
        const header = raw.match(/^((?:#[^\n]*\n)+)/);
        fs.writeFileSync(p, (header ? header[1] : '') + yaml.dump(doc, { lineWidth: 120, noRefs: true }));
        console.log('updated', path.relative(ROOT, p));
      }
    }
  }
}

walk(FIX);
console.log('✓ fixture structured money/quantity rewrite complete');
