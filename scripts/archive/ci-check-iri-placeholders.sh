#!/bin/bash
# CI Check: Detect IRI Placeholder Leakage
# This script fails if {BASE_IRI} placeholders are found in production-ready files
# Usage: ./scripts/ci-check-iri-placeholders.sh

set -e

echo "=========================================="
echo "CI Check: IRI Placeholder Detection"
echo "=========================================="

# Files that should NOT contain {BASE_IRI} in production
PRODUCTION_PATTERNS=(
  "ontology/domain/**/*.yaml"
  "ontology/domain/**/*.yml"
  "generated/**/*.ttl"
  "generated/**/*.rdf"
  "generated/**/*.jsonld"
)

PLACEHOLDER_FOUND=0

for PATTERN in "${PRODUCTION_PATTERNS[@]}"; do
  # Check if pattern matches any files
  FILES=$(find . -path "./$PATTERN" 2>/dev/null || true)

  if [ -z "$FILES" ]; then
    continue
  fi

  for FILE in $FILES; do
    if grep -q "{BASE_IRI}" "$FILE" 2>/dev/null; then
      echo "❌ FAIL: Placeholder found in production file: $FILE"
      PLACEHOLDER_FOUND=1
    fi
  done
done

# Meta-model files are ALLOWED to have placeholders (they are templates)
# But we still report them for awareness
META_FILES=$(find ontology/meta -name "*.yaml" -exec grep -l "{BASE_IRI}" {} \; 2>/dev/null || true)
if [ -n "$META_FILES" ]; then
  echo ""
  echo "ℹ️  INFO: Meta-model files with placeholders (OK):"
  echo "$META_FILES" | sed 's/^/  - /'
fi

echo ""
if [ $PLACEHOLDER_FOUND -eq 1 ]; then
  echo "=========================================="
  echo "FAILURE: IRI placeholders detected!"
  echo "=========================================="
  echo ""
  echo "Production files must not contain {BASE_IRI} placeholders."
  echo "Please run: ./scripts/replace-iri-placeholders.sh <BASE_IRI>"
  echo ""
  echo "See ADR-002 for IRI namespace strategy."
  exit 1
else
  echo "=========================================="
  echo "SUCCESS: No placeholder leakage detected"
  echo "=========================================="
  exit 0
fi
