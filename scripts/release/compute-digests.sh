#!/usr/bin/env bash
# Compute SHA-256 digests for all M2 release artifacts
# Usage: ./compute-digests.sh <release-version>

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
DIGEST_FILE="${RELEASE_DIR}/digests.txt"

echo "Computing digests for M2 ${RELEASE_VERSION}"
echo "Release directory: ${RELEASE_DIR}"
echo ""

# Create release directory structure if needed
mkdir -p "${RELEASE_DIR}"/{modules,owl,shacl,evidence,tests,docs}

# Compute digests for all artifacts
{
  echo "# M2 ${RELEASE_VERSION} Artifact Digests"
  echo "# Generated: $(date -Iseconds)"
  echo "# Format: <sha256>  <filepath>"
  echo ""

  echo "## Module Sources"
  find ontology/domain/finance -name "module.yaml" -type f -exec sha256sum {} \; | sort -k2

  echo ""
  echo "## Generated OWL"
  find generated/ontology/finance -path "*/owl/*" -name "*.ttl" -o -name "*.owl.ttl" | sort | xargs sha256sum 2>/dev/null || echo "# No OWL files found"

  echo ""
  echo "## Generated SHACL"
  find generated/ontology/finance -path "*/shacl/*" -name "*.ttl" -o -name "*.shacl.ttl" | sort | xargs sha256sum 2>/dev/null || echo "# No SHACL files found"

  echo ""
  echo "## Evidence Artifacts"
  find docs/ontology/terminology -name "*.yaml" -type f -exec sha256sum {} \; 2>/dev/null | sort -k2 || echo "# No terminology cards found"
  find docs/ontology/competency-questions -name "*.yaml" -type f -exec sha256sum {} \; 2>/dev/null | sort -k2 || echo "# No CQs found"

  echo ""
  echo "## Test Fixtures"
  find tests/m2/fixtures -name "*.yaml" -type f -exec sha256sum {} \; 2>/dev/null | sort -k2 || echo "# No fixtures found"

} > "$DIGEST_FILE"

echo "Digests written to: ${DIGEST_FILE}"
echo ""
echo "Summary:"
MODULE_COUNT=$(grep -c "module.yaml" "$DIGEST_FILE" || echo "0")
OWL_COUNT=$(grep -c ".owl.ttl" "$DIGEST_FILE" || echo "0")
SHACL_COUNT=$(grep -c ".shacl.ttl" "$DIGEST_FILE" || echo "0")
echo "${MODULE_COUNT} modules"
echo "${OWL_COUNT} OWL files"
echo "${SHACL_COUNT} SHACL files"
