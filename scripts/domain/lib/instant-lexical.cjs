'use strict';

const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function parseUtcInstantNanoseconds(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`invalid UTC instant lexical value ${String(value)}`);
  }
  const match = UTC_INSTANT_RE.exec(value);
  if (!match) throw new TypeError(`invalid UTC instant lexical value ${value}`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const date = new Date(0);
  date.setUTCHours(hour, minute, second, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (!Number.isFinite(date.getTime())
      || date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
      || date.getUTCHours() !== hour
      || date.getUTCMinutes() !== minute
      || date.getUTCSeconds() !== second) {
    throw new TypeError(`invalid UTC instant lexical value ${value}`);
  }
  const fractionalNanoseconds = BigInt((fraction || '0').padEnd(9, '0'));
  return (BigInt(date.getTime()) * NANOSECONDS_PER_MILLISECOND) + fractionalNanoseconds;
}

function isUtcInstantLexical(value) {
  try {
    parseUtcInstantNanoseconds(value);
    return true;
  } catch {
    return false;
  }
}

function compareUtcInstantLexical(left, right) {
  const leftNanoseconds = parseUtcInstantNanoseconds(left);
  const rightNanoseconds = parseUtcInstantNanoseconds(right);
  if (leftNanoseconds < rightNanoseconds) return -1;
  if (leftNanoseconds > rightNanoseconds) return 1;
  return 0;
}

function utcInstantDifferenceNanoseconds(later, earlier) {
  return parseUtcInstantNanoseconds(later) - parseUtcInstantNanoseconds(earlier);
}

function durationNanosecondsToDecimalSeconds(nanoseconds) {
  if (typeof nanoseconds !== 'bigint' || nanoseconds <= 0n) return null;
  const seconds = nanoseconds / NANOSECONDS_PER_SECOND;
  const remainder = nanoseconds % NANOSECONDS_PER_SECOND;
  if (remainder === 0n) return seconds.toString();
  const fraction = remainder.toString().padStart(9, '0').replace(/0+$/u, '');
  return `${seconds}.${fraction}`;
}

module.exports = {
  NANOSECONDS_PER_SECOND,
  compareUtcInstantLexical,
  durationNanosecondsToDecimalSeconds,
  isUtcInstantLexical,
  parseUtcInstantNanoseconds,
  utcInstantDifferenceNanoseconds,
};
