'use strict';

/**
 * Validate the deliberately small, parameter-free SPARQL SELECT subset that
 * the M2 SHACL projector may execute over a local data graph.
 *
 * This is not a general SPARQL parser.  Unsupported syntax fails closed.  The
 * release gate still parses and executes emitted queries with pinned pySHACL;
 * this check prevents remote graph access, update operations, subqueries, and
 * other constructs that do not belong in a deterministic NodeShape contract.
 */

const SELECT_HEAD_RE =
  /^SELECT[ \t]+\$this(?:[ \t]+\?[A-Za-z_][A-Za-z0-9_]*)*[ \t]*\n?WHERE[ \t]*\{/u;
const FORBIDDEN_KEYWORD_RE =
  /\b(?:BASE|PREFIX|FROM|NAMED|SERVICE|GRAPH|VALUES|BINDINGS|UNION|MINUS|EXISTS|CONSTRUCT|DESCRIBE|ASK|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY|INSERT|DELETE|WITH|USING)\b/iu;
const VARIABLE_PREDICATE_RE =
  /(?:\$this|\?[A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]+\?[A-Za-z_][A-Za-z0-9_]*[ \t\r\n]+(?:<https?:\/\/|\$this\b|\?[A-Za-z_][A-Za-z0-9_]*\b)[^.\n]*\./u;
const ABSOLUTE_IRI_RE = /^https?:\/\/[^\s<>]+$/u;
const STATIC_RESULT_PATH_BIND_RE =
  /\bBIND[ \t]*\([ \t]*<(https?:\/\/[^\s<>]+)>[ \t]+AS[ \t]+\?path[ \t]*\)/giu;

function scanDelimiters(expression) {
  let braces = 0;
  let parentheses = 0;
  let inIri = false;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (inIri) {
      if (character === '>') inIri = false;
      continue;
    }
    if (character === '<') {
      const end = expression.indexOf('>', index + 1);
      if (end === -1) return 'contains an unterminated IRI token';
      const iri = expression.slice(index + 1, end);
      if (!ABSOLUTE_IRI_RE.test(iri)) {
        return `contains a non-absolute or malformed IRI token <${iri}>`;
      }
      inIri = true;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      return 'literal and template quoting is outside the direct SELECT subset';
    }
    if (character === '#') {
      return 'SPARQL comments are outside the direct SELECT subset';
    }
    if (character === '{') braces += 1;
    if (character === '}') braces -= 1;
    if (character === '(') parentheses += 1;
    if (character === ')') parentheses -= 1;
    if (braces < 0 || parentheses < 0) return 'contains unbalanced delimiters';
  }
  if (inIri || braces !== 0 || parentheses !== 0) return 'contains unbalanced delimiters';
  return null;
}

function directSparqlSelectError(expression) {
  if (typeof expression !== 'string') return 'must be a string';
  if (expression.length === 0 || expression.length > 8192) {
    return 'must contain between 1 and 8192 characters';
  }
  if (expression !== expression.normalize('NFC')) return 'must be Unicode NFC';
  if (expression !== expression.trim()) return 'must not have leading or trailing whitespace';
  if (expression.includes('\r')) return 'must use LF line endings';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(expression)) {
    return 'contains a forbidden control character';
  }
  if (!SELECT_HEAD_RE.test(expression) || !/\}\s*$/u.test(expression)) {
    return 'must be one parameter-free SELECT $this ... WHERE { ... } query';
  }
  if ((expression.match(/\bSELECT\b/giu) || []).length !== 1
      || (expression.match(/\bWHERE\b/giu) || []).length !== 1) {
    return 'subqueries or multiple WHERE clauses are not supported';
  }
  const forbidden = FORBIDDEN_KEYWORD_RE.exec(expression);
  if (forbidden) return `forbidden SPARQL keyword ${forbidden[0].toUpperCase()}`;
  if (VARIABLE_PREDICATE_RE.test(expression)) {
    return 'variable predicates are outside the direct SELECT subset';
  }
  if (!/\$this[ \t\r\n]+<https?:\/\/[^>\s]+>/u.test(expression)) {
    return 'must constrain $this through at least one absolute-IRI predicate';
  }
  return scanDelimiters(expression);
}

function assertDirectSparqlSelect(expression, path = 'expression') {
  const message = directSparqlSelectError(expression);
  if (message) {
    const error = new Error(`${path}: unsupported direct SPARQL SELECT: ${message}`);
    error.code = 'M2-DIRECT-SPARQL-SELECT';
    throw error;
  }
  return expression;
}

/**
 * Return the one static SHACL result path projected by a direct SELECT.
 *
 * A constraint-instance manifest has one stable optional path.  A query that
 * projects `?path` from data-dependent bindings cannot be represented by that
 * contract and therefore fails closed instead of letting the executor ignore
 * a resultPath that is absent from the manifest.
 */
function directSparqlStaticResultPath(expression, path = 'expression') {
  assertDirectSparqlSelect(expression, path);
  const selectHead = expression.slice(0, expression.search(/\bWHERE\b/u));
  const projectsPath = /(?:^|[^A-Za-z0-9_])\?path(?![A-Za-z0-9_])/u.test(selectHead);
  const matches = [...expression.matchAll(STATIC_RESULT_PATH_BIND_RE)];
  if (!projectsPath) {
    if (matches.length > 0) {
      const error = new Error(
        `${path}: direct SPARQL binds ?path without projecting it in SELECT`,
      );
      error.code = 'M2-DIRECT-SPARQL-RESULT-PATH';
      throw error;
    }
    return null;
  }
  if (matches.length !== 1) {
    const error = new Error(
      `${path}: projected ?path must be bound exactly once to one static absolute IRI`,
    );
    error.code = 'M2-DIRECT-SPARQL-RESULT-PATH';
    throw error;
  }
  return matches[0][1];
}

module.exports = {
  assertDirectSparqlSelect,
  directSparqlStaticResultPath,
  directSparqlSelectError,
};
