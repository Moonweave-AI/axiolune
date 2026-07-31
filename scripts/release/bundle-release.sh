#!/usr/bin/env bash
# Bundle all M2 release artifacts into release directory structure
# Usage: ./bundle-release.sh <release-version>

set -euo pipefail

RELEASE_VERSION="${1:-}"
if [ -z "$RELEASE_VERSION" ]; then
  echo "Error: Release version required"
  echo "Usage: $0 <release-version>"
  echo "Example: $0 v0.1.0"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RELEASE_DIR="releases/${RELEASE_VERSION}"

echo "Bundling M2 ${RELEASE_VERSION} release artifacts"
echo "Release directory: ${RELEASE_DIR}"
echo ""

# Create release directory structure
mkdir -p "${RELEASE_DIR}"/{modules,owl,shacl,evidence/terminology,evidence/competency-questions,evidence/alignments,tests/fixtures/positive,tests/fixtures/negative,tests/reports,docs}

echo "1. Copying module sources..."
for module_dir in ontology/domain/finance/*/; do
  if [ -f "${module_dir}module.yaml" ]; then
    module_name=$(basename "$module_dir")
    mkdir -p "${RELEASE_DIR}/modules/${module_name}"
    cp "${module_dir}module.yaml" "${RELEASE_DIR}/modules/${module_name}/"
    echo "  âœ?${module_name}"
  fi
done

echo ""
echo "2. Copying generated OWL ontologies..."
find generated/ontology/finance -name "*.owl.ttl" | while read -r owl_file; do
  cp "$owl_file" "${RELEASE_DIR}/owl/"
  echo "  âœ?$(basename "$owl_file")"
done

echo ""
echo "3. Copying generated SHACL shapes..."
find generated/ontology/finance -name "*.shacl.ttl" | while read -r shacl_file; do
  cp "$shacl_file" "${RELEASE_DIR}/shacl/"
  echo "  âœ?$(basename "$shacl_file")"
done

echo ""
echo "4. Copying evidence artifacts..."
if [ -d "docs/ontology/terminology" ]; then
  cp docs/ontology/terminology/*.yaml "${RELEASE_DIR}/evidence/terminology/" 2>/dev/null || true
  TERM_COUNT=$(ls -1 "${RELEASE_DIR}/evidence/terminology/" 2>/dev/null | wc -l)
  echo "  âœ?${TERM_COUNT} terminology cards"
fi

if [ -d "docs/ontology/competency-questions" ]; then
  cp docs/ontology/competency-questions/*.yaml "${RELEASE_DIR}/evidence/competency-questions/" 2>/dev/null || true
  CQ_COUNT=$(ls -1 "${RELEASE_DIR}/evidence/competency-questions/" 2>/dev/null | wc -l)
  echo "  âœ?${CQ_COUNT} competency questions"
fi

if [ -f "docs/ontology/references.lock.yaml" ]; then
  cp docs/ontology/references.lock.yaml "${RELEASE_DIR}/evidence/"
  echo "  âœ?references.lock.yaml"
fi

echo ""
echo "5. Copying test fixtures..."
if [ -d "tests/m2/fixtures/positive" ]; then
  cp tests/m2/fixtures/positive/*.yaml "${RELEASE_DIR}/tests/fixtures/positive/" 2>/dev/null || true
  POS_COUNT=$(ls -1 "${RELEASE_DIR}/tests/fixtures/positive/" 2>/dev/null | wc -l)
  echo "  âœ?${POS_COUNT} positive fixtures"
fi

if [ -d "tests/m2/fixtures/negative" ]; then
  cp tests/m2/fixtures/negative/*.yaml "${RELEASE_DIR}/tests/fixtures/negative/" 2>/dev/null || true
  NEG_COUNT=$(ls -1 "${RELEASE_DIR}/tests/fixtures/negative/" 2>/dev/null | wc -l)
  echo "  âœ?${NEG_COUNT} negative fixtures"
fi

echo ""
echo "6. Copying documentation..."
cp docs/domain/decisions/M2-V0.1.0-RELEASE-NOTES.md "${RELEASE_DIR}/docs/" 2>/dev/null || echo "  ! Release notes not found"
cp docs/domain/decisions/ADR-014-m2-release-governance.md "${RELEASE_DIR}/docs/" 2>/dev/null || echo "  ! ADR-014 not found"
cp releases/INTERDEPENDENCY-MATRIX.yaml "${RELEASE_DIR}/docs/" 2>/dev/null || echo "  ! Interdependency matrix not found"

echo ""
echo "7. Copying digests..."
cp "${RELEASE_DIR}/digests.txt" "${RELEASE_DIR}/digests.txt.bak" 2>/dev/null || true

echo ""
echo "âœ?Release bundle complete: ${RELEASE_DIR}"
echo ""
echo "Contents:"
echo "  Modules: $(ls -1 ${RELEASE_DIR}/modules | wc -l) directories"
echo "  OWL: $(ls -1 ${RELEASE_DIR}/owl/*.ttl 2>/dev/null | wc -l) files"
echo "  SHACL: $(ls -1 ${RELEASE_DIR}/shacl/*.ttl 2>/dev/null | wc -l) files"
echo "  Evidence: $(ls -1 ${RELEASE_DIR}/evidence/terminology/*.yaml 2>/dev/null | wc -l) terminology + $(ls -1 ${RELEASE_DIR}/evidence/competency-questions/*.yaml 2>/dev/null | wc -l) CQs"
echo "  Tests: $(ls -1 ${RELEASE_DIR}/tests/fixtures/positive/*.yaml 2>/dev/null | wc -l) positive + $(ls -1 ${RELEASE_DIR}/tests/fixtures/negative/*.yaml 2>/dev/null | wc -l) negative"

# Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
