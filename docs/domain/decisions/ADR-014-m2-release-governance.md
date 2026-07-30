# ADR-014: M2 Release Governance and Compatibility Framework

**Status**: Proposed  
**Date**: 2026-07-30  
**Context**: E7 (Release governance) — M2 v0.1.0 preparation  
**Upstream**: ADR-013 (M2 Authoring Profile), M2-PLAN §13 E7

---

## Context

All 10 planned M2 modules have been delivered and validated:
- **Modules**: fin-foundation, fin-market-structure, fin-market-rules, fin-instruments, fin-market-data, fin-portfolio-positions, fin-orders-execution, fin-strategy-research, fin-risk, fin-post-trade-operations
- **Validation**: 100% G0 pass, 100% PIT pass (43 positive, 12 negative), 1,760 RDF triples (903 OWL + 857 SHACL)
- **Evidence**: 52 terminology cards, 42 competency questions, 62 test fixtures
- **Semantic chains**: Complete Slice A (Instrument → Price → Valuation), Slice B (Order → Execution → Position), Research-to-Execution, Market-to-Risk, Trade-to-Operations

Before these modules can be published as M2 v0.1.0, we need:
1. A release governance framework defining what constitutes a release
2. A compatibility assessment strategy for future changes
3. A module interdependency lock mechanism
4. A release manifest format that ensures reproducibility
5. A deprecation and migration policy

This ADR establishes the release governance framework for M2 and all future Axiolune ontology releases.

---

## Decision

### 1. Release Manifest Structure

Every M2 release SHALL be defined by a single, immutable `release-manifest.yaml` containing:

```yaml
releaseId: "m2-v0.1.0"
releaseVersion: "0.1.0"
releaseDate: "2026-07-30"
status: "candidate"  # candidate | approved | deprecated
releaseType: "initial"  # initial | minor | major | patch

# Semantic versioning strategy
semver:
  major: 0   # Breaking changes to module structure, IRI patterns, or M3 contract
  minor: 1   # New modules, new types, new non-required attributes
  patch: 0   # Documentation fixes, evidence updates, non-semantic corrections

# All modules locked to specific versions with artifact digests
modules:
  - moduleIri: "https://axiolune.ai/ontology/finance/foundation"
    version: "0.1.0"
    status: "approved"
    sourceDigest: "sha256:..."
    owlDigest: "sha256:..."
    shaclDigest: "sha256:..."
  - moduleIri: "https://axiolune.ai/ontology/finance/market-structure"
    version: "0.1.0"
    status: "approved"
    sourceDigest: "sha256:..."
    owlDigest: "sha256:..."
    shaclDigest: "sha256:..."
  # ... all 10 modules

# External dependencies locked
externalDependencies:
  - authority: "FIBO"
    release: "2026Q1"
    artifactUrl: "https://spec.edmcouncil.org/fibo/ontology/2026Q1/"
    digest: "sha256:..."
    importPolicy: "linked-data-alignment"
    usageScope: "terminology-alignment"
  - authority: "ISO-6166"
    release: "2021"
    standard: "ISIN"
    usageScope: "identifier-definition"
  - authority: "ISO-10383"
    release: "2024"
    standard: "MIC"
    usageScope: "identifier-definition"
  - authority: "ISO-17442"
    release: "2020"
    standard: "LEI"
    usageScope: "identifier-definition"

# Validation summary from CI
validation:
  g0ValidationPass: 10
  g0ValidationFail: 0
  pitPositivePass: 43
  pitPositiveFail: 0
  pitNegativeReject: 12
  pitNegativePass: 0
  owlConsistency: "consistent"
  shaclGeneration: "deterministic"
  totalTriples: 1760
  owlTriples: 903
  shaclTriples: 857

# Test bundle digest
testBundle:
  terminologyCards: 52
  competencyQuestions: 42
  positiveFixtures: 27
  negativeFixtures: 35
  fixtureDigest: "sha256:..."
  testReportDigest: "sha256:..."

# Compatibility assessment
compatibility:
  breakingChanges: []  # Empty for v0.1.0 (initial release)
  deprecations: []
  migrations: []

# Release artifacts
artifacts:
  - name: "m2-modules-source-bundle"
    path: "releases/v0.1.0/modules/"
    digest: "sha256:..."
  - name: "m2-owl-bundle"
    path: "releases/v0.1.0/owl/"
    digest: "sha256:..."
  - name: "m2-shacl-bundle"
    path: "releases/v0.1.0/shacl/"
    digest: "sha256:..."
  - name: "m2-evidence-bundle"
    path: "releases/v0.1.0/evidence/"
    digest: "sha256:..."
  - name: "m2-test-report-bundle"
    path: "releases/v0.1.0/reports/"
    digest: "sha256:..."

metadata:
  releaseNotes: "docs/domain/decisions/M2-V0.1.0-RELEASE-NOTES.md"
  migrationGuide: null  # Not applicable for initial release
  approvedBy: null  # Pending governance review
  approvalDate: null
```

### 2. Semantic Versioning Strategy

M2 releases follow semantic versioning with domain-specific interpretation:

| Version Component | Triggers | Examples |
|---|---|---|
| **MAJOR** (breaking) | M3 contract violation; IRI pattern change; module removal; required attribute removal; incompatible Pattern binding change | `1.0.0`, `2.0.0` |
| **MINOR** (additive) | New module; new ObjectType/AssociationType; new optional attribute; new CodeList value; new Pattern binding (compatible) | `0.2.0`, `0.3.0` |
| **PATCH** (non-semantic) | Documentation fix; terminology card update; evidence source update; test fixture addition; generated artifact regeneration with no semantic change | `0.1.1`, `0.1.2` |

**Breaking change examples**:
- Changing an IRI from `https://axiolune.ai/ontology/finance/instruments/FinancialInstrument` to a different IRI
- Removing a module or type
- Changing an optional attribute to required (minCount: 0 → 1)
- Removing a CodeList value that is in use
- Changing an attribute's datatype in an incompatible way

**Non-breaking change examples**:
- Adding a new module
- Adding a new optional attribute (minCount: 0)
- Adding a new CodeList value
- Adding a new competency question or fixture
- Updating terminology card sources or definitions (if not changing semantics)

### 3. Module Interdependency Matrix

All module dependencies MUST be explicitly declared and version-locked. The release process SHALL generate an interdependency matrix:

```yaml
# Module interdependency matrix for M2 v0.1.0
dependencies:
  fin-foundation:
    version: "0.1.0"
    imports: []
    importedBy:
      - fin-market-structure: "0.1.0"
      - fin-instruments: "0.1.0"
      - fin-portfolio-positions: "0.1.0"
  
  fin-market-structure:
    version: "0.1.0"
    imports:
      - fin-foundation: "0.1.0"
    importedBy:
      - fin-instruments: "0.1.0"
      - fin-market-rules: "0.1.0"
      - fin-market-data: "0.1.0"
      - fin-orders-execution: "0.1.0"
  
  # ... full dependency graph for all 10 modules
```

**Dependency rules**:
- Circular imports are FORBIDDEN and SHALL fail G0 validation
- Forward references (importing a module not yet approved) are FORBIDDEN
- Version drift (importing v0.1.0 in one module, v0.2.0 in another) triggers a compatibility review
- All imports MUST reference `approved` modules only

### 4. Compatibility Assessment Process

For every release after v0.1.0, a compatibility assessment MUST be performed:

**Step 1: Change Classification**
- Scan all module diffs (source YAML, generated OWL/SHACL)
- Classify each change as MAJOR, MINOR, or PATCH per versioning strategy
- Identify affected downstream modules and consumers

**Step 2: Impact Analysis**
```yaml
compatibilityAssessment:
  proposedVersion: "0.2.0"
  changeType: "minor"  # major | minor | patch
  
  changes:
    - changeId: "C-001"
      module: "fin-instruments"
      changeType: "addition"
      severity: "minor"
      description: "Added optional attribute 'hasCFI' to FinancialInstrument"
      affectedTypes:
        - "https://axiolune.ai/ontology/finance/instruments/FinancialInstrument"
      breakingChange: false
      migrationRequired: false
      
    - changeId: "C-002"
      module: "fin-derivatives"
      changeType: "new-module"
      severity: "minor"
      description: "Added new module for derivative instruments"
      affectedTypes: []
      breakingChange: false
      migrationRequired: false
```

**Step 3: Migration Planning**
- If breakingChange: true, produce migration guide
- If deprecation introduced, specify deprecation timeline and replacement
- Document rollback procedure

### 5. Deprecation Policy

Deprecated elements follow a staged sunset:

```yaml
deprecation:
  elementIri: "https://axiolune.ai/ontology/finance/old/SomeType"
  deprecatedInVersion: "0.3.0"
  deprecatedDate: "2026-08-15"
  removalPlannedVersion: "1.0.0"
  removalPlannedDate: "2027-01-01"
  reason: "Replaced by https://axiolune.ai/ontology/finance/new/ImprovedType due to incomplete temporal semantics"
  replacement:
    iri: "https://axiolune.ai/ontology/finance/new/ImprovedType"
    migrationGuide: "docs/migrations/old-to-improved.md"
  status: "sunset-announced"  # sunset-announced | sunset-active | removed
```

**Deprecation timeline**:
- **Announcement**: Element marked `deprecated` in module metadata; OWL annotation added; warnings in validation
- **Sunset period**: Minimum 2 minor releases or 3 months (whichever is longer)
- **Removal**: Element removed in next MAJOR release; migration guide MUST be available

### 6. Release Approval Checklist

Before marking a release as `approved`:

- [ ] All modules in release manifest are `approved`
- [ ] All module versions locked with source + generated artifact digests
- [ ] All external dependencies locked with release/commit + artifact digest
- [ ] G0 validation: 100% pass
- [ ] PIT validation: 100% pass (positive accepted, negative rejected)
- [ ] OWL consistency check: passed with pinned reasoner
- [ ] SHACL determinism: two builds produce identical output
- [ ] Terminology cards: all public types covered
- [ ] Competency questions: all core queries have fixtures
- [ ] Test fixtures: positive + negative coverage for all constraints
- [ ] Interdependency matrix: generated and DAG verified
- [ ] Compatibility assessment: completed (if not initial release)
- [ ] Release notes: written and reviewed
- [ ] Migration guide: written (if breaking changes exist)
- [ ] Release artifacts: bundled with matching digests
- [ ] Test report bundle: from same CI run as artifacts

### 7. Release Artifact Bundle Structure

```
releases/
  v0.1.0/
    release-manifest.yaml          # Single source of truth for this release
    modules/                        # All 10 module source files
      fin-foundation/
        module.yaml
      fin-market-structure/
        module.yaml
      # ... all modules
    owl/                           # Generated OWL ontologies
      fin-foundation.ttl
      fin-market-structure.ttl
      # ... all modules
    shacl/                         # Generated SHACL shapes
      fin-foundation-shapes.ttl
      fin-market-structure-shapes.ttl
      # ... all modules
    evidence/                      # Evidence artifacts
      terminology/
      competency-questions/
      alignments/
      references.lock.yaml
    tests/                         # Test fixtures and reports
      fixtures/positive/
      fixtures/negative/
      reports/
        g0-validation-report.json
        pit-validation-report.json
        owl-consistency-report.txt
    docs/
      M2-V0.1.0-RELEASE-NOTES.md
      INTERDEPENDENCY-MATRIX.yaml
      COMPATIBILITY-ASSESSMENT.yaml  # Empty for v0.1.0
    digests.txt                    # SHA-256 of all artifacts
```

---

## Consequences

### Positive

1. **Reproducibility**: Every release is fully reproducible from locked versions and digests
2. **Compatibility transparency**: Changes are explicitly classified and assessed
3. **Safe evolution**: Breaking changes require MAJOR version bump and migration guide
4. **Dependency safety**: Version-locked imports prevent drift and surprise breakage
5. **Release integrity**: All artifacts from single CI run with matching digests
6. **Deprecation clarity**: Staged sunset with replacement guidance reduces disruption

### Negative

1. **Release overhead**: Compatibility assessment and artifact bundling add process weight
2. **Version coordination**: Multiple modules changing together requires coordinated version bumps
3. **Digest maintenance**: All artifact digests must be computed and tracked
4. **Tooling dependency**: Requires automation for digest computation, diff analysis, and bundling

### Mitigations

- Automate compatibility assessment with diff analyzer tool
- Generate interdependency matrix and digests as part of CI pipeline
- Template release notes and migration guides to reduce manual effort
- Build release bundle as part of normal build process (no separate step)

---

## Implementation Plan

1. **Create release tooling**:
   - `scripts/release/compute-digests.sh`: Compute SHA-256 for all artifacts
   - `scripts/release/generate-interdependency-matrix.js`: Extract module dependency graph
   - `scripts/release/bundle-release.sh`: Package all artifacts into release structure
   - `scripts/release/validate-release.sh`: Verify release manifest completeness

2. **Generate v0.1.0 artifacts**:
   - Compute digests for all 10 modules (source + generated OWL/SHACL)
   - Lock external dependency versions (FIBO 2026Q1, ISO standards)
   - Bundle all evidence artifacts (terminology cards, CQs, alignments)
   - Bundle all test fixtures and validation reports

3. **Write release documentation**:
   - M2-V0.1.0-RELEASE-NOTES.md (what's included, key design decisions, known limitations)
   - INTERDEPENDENCY-MATRIX.yaml (dependency graph for all 10 modules)
   - COMPATIBILITY-ASSESSMENT.yaml (empty for initial release, template for future)

4. **Submit for approval**:
   - Mark release manifest as `candidate`
   - Run full validation suite (G0, PIT, OWL consistency)
   - Verify all artifacts have matching digests
   - Request governance approval → mark as `approved`

---

## References

- M2-PLAN §13 E7 (Release governance)
- ADR-013 (M2 Authoring Profile)
- Semantic Versioning 2.0.0: https://semver.org/
- FIBO Release Process: https://github.com/edmcouncil/fibo/blob/master/RELEASE-PROCESS.md

---

**Decision Date**: 2026-07-30  
**Approved By**: Pending  
**Review Date**: 2027-01-30 (6 months after first release)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
