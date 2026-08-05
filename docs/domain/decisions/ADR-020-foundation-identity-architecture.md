# ADR-020: Foundation Identity Architecture (v2.0.0)

**Status**: Accepted  
**Date**: 2026-08-04  
**Context**: Independent read-only review of `fin-foundation` v1.0.0 (2026-08-04)  
**Related**: ADR-014 (release governance), ADR-017 (v1.0.0 completion), M2-PLAN §5.2, RFC-001 axis 1 (identity)

## Context

An independent semantic review of `fin-foundation` v1.0.0 concluded: **retain the module, require architectural revision (Request changes)**. The review cross-checked the module against ISO 6166, ISO 17442, ISO 10383, ISO 4217, ISO 20022, FIBO, and W3C ORG, and identified seven P0 issues that should be decided and addressed before M1 or downstream modules treat foundation as a frozen contract.

The review did not modify any files or run gates. This ADR records the decisions and governs the v1.0.0 → **v2.0.0** major version bump per ADR-014 (structural changes to module structure and identity patterns).

### Module boundary (revised)

Foundation provides cross-financial reusable semantics for **identifiers, subjects, jurisdictions, currency, and authoritative reference data**. It does **not** own account lifecycle, financial instrument reference data, or market venue business models.

Foundation owns:
- Stable shared entities: Party, organization/legal-entity interfaces, Currency, Jurisdiction.
- Identifier infrastructure: Scheme, Scheme Release, Identifier Value, Namespace, Assignment, Authority Role.
- Authoritative reference data: Registry Publication, Registry Entry Assertion.
- Traceable qualification facts: names, identifier assignments, currency legal status, jurisdiction relations.
- Data quality findings: conflicts, revocations, reassignments, validation results.

Not in Foundation:
- Financial instruments, issuers, listings, market segments, trading venues.
- Account products, custody relationships, holding capabilities, payment account lifecycle.
- Complete legal, organizational, person, geographic upper ontology.
- M3 Money / Quantity value types (never redefined).

## Decisions

### D1. IdentifierNamespace — fix the authority-scoped identity key

**Problem**: `IdentifierValue`'s logical key is `(scheme, canonical lexical)`, but `IdentifierUniquenessScope` allows `authorityScoped`. Two banks using the same local account number `12345` would be treated as the same identifier.

**Decision**: Introduce `IdentifierNamespace` as a first-class object type. The identity key becomes:
- Global schemes: `(scheme, canonicalLexicalForm)` — unchanged.
- Authority-scoped schemes: `(scheme, namespace, canonicalLexicalForm)` — namespace is mandatory.

The existing `IdentifierValue` IRI is **retained**; `IdentifierNamespace` is added as a new optional participant in `FinancialIdentifierAssignment` and as a required attribute for authority-scoped `LocalIdentifierValue`. This is additive and does not break the 171 downstream IRI references.

### D2. Scheme / Release layering — separate stable identity from versioned rules

**Problem**: `IdentifierScheme`, `identifierSchemeVersion`, FactVersion, maintainer, and assignment relations conflate "scheme identity" with "scheme release". A standard rule update or maintainer change could be misread as a new scheme or new identifier.

**Decision**: Introduce `IdentifierSchemeRelease` as a new object type. `IdentifierScheme` represents the stable scheme series; `IdentifierSchemeRelease` represents a versioned set of rules (syntax, compatibility, validator profile). A new `hasRelease` relation links them. The existing `identifierSchemeVersion` string attribute is **retained but deprecated** (`deprecated: notBefore 2.0.0`, `replacedBy: IdentifierSchemeRelease`); downstream modules continue to work.

### D3. Authority Role Assignment — replace functional maintainer with temporal role facts

**Problem**: `IdentifierAuthorityRole` has only `assigningAuthority`, yet the module has maintainer, registry authority, and other relationships. Real-world governance (ANNA/NNA, GLEIF/LOU, SWIFT, SIX) cannot be expressed.

**Decision**: Introduce `AuthorityRoleAssignment` as a new association type — a temporal fact assigning an organization a reviewed role under a given Scheme Release, with a validity interval and evidence. The `IdentifierAuthorityRole` code list is **extended** (not replaced) with: `registrationAuthority`, `maintenanceAgency`, `issuingAuthority`, `registryPublisher`, `validationAuthority` (alongside existing `assigningAuthority`). The existing `identifierSchemeMaintainer` functional relation is **retained but deprecated** (`replacedBy: AuthorityRoleAssignment`).

### D4. Assignment logical-identity anchoring

**Problem**: `FinancialIdentifierAssignment` anchors on exact FactVersion of the subject; account roles and currency usage use LogicalReference. A legal entity that produces a new version due to a name or address correction would break LEI/ISIN assignment in PIT queries.

**Decision**: `FinancialIdentifierAssignment` participant roles remain exact-version (for evidence integrity), but a new `assignmentLogicalSubject` attribute is added to anchor the assignment to the stable logical identity. The `ExactVersionReference` constraint bindings are **retained**; a `LogicalReference` binding is added alongside. This is additive.

### D5. ISO 4217 — entry kind, publication, and minor-unit applicability

**Problem**: ISO 4217 entries include currencies, funds, precious metals, and special items; `0` minor unit ≠ `N.A.`; `active/withdrawn` cannot express historical, replacement, coexistence, or publication releases.

**Decision**: Introduce `ISO4217RegistryPublication` (object type) and `ISO4217EntryKind` / `ISO4217ListCategory` (code lists). `ISO4217RegistryEntry` is extended with `entryKind`, `effectiveFrom`, `effectiveTo`, `replacedBy`. The `iso4217MinorUnit` integer attribute is **retained** but its constraint is relaxed to allow `N.A.` via a new `minorUnitApplicability` attribute. The existing IRI is retained.

### D6. BusinessCalendar — thin interface in Foundation, specialized by market-structure

**Problem**: M2-PLAN §5.2 requires Foundation to provide a calendar interface, but the module has no `BusinessCalendar` / `JurisdictionCalendarBinding`. `JurisdictionCalendarBinding` is already defined in `fin-market-structure`. CQ and mapping narratives reference it.

**Decision**: Foundation defines a **thin `BusinessCalendar` interface** (object type, no session/exception details). `fin-market-structure` already provides `TradingCalendar` (specialization) and `JurisdictionCalendarBinding`. M2-PLAN §5.2 is updated to reflect that Foundation provides the interface and market-structure provides the concrete calendar. This resolves the scope/CQ/contract drift without duplicating market-structure's calendar.

### D7. Account boundary — thin interface, product/custody semantics deferred

**Problem**: `FinancialAccount` with `cash / securitiesCustody / multiAsset` holding capabilities and the full account role system exceed Foundation's boundary.

**Decision**: `FinancialAccount` is **retained** in Foundation as a thin "identifiable holding account" interface. `AccountType` is renamed to `HoldingCapabilityKind` (old IRI retained as deprecated alias). The full account product, custody, and service-party semantics are documented as belonging to a future account/custody module. `FinancialAccountPartyRole` role list is narrowed to `holder / servicer / custodian / operator`; beneficial ownership, agency, trust, and management authority are deferred to that module. No existing IRI is removed.

## Compatibility strategy

- All existing foundation IRIs are **retained**.
- New concepts use new IRIs under the same `.../finance/foundation/` namespace.
- Deprecated fields/relations carry `deprecated: true`, `deprecatedSince: 2.0.0`, `replacedBy: <new IRI>`, `removalVersion: 3.0.0`.
- Module version bumps to **2.0.0** (major, per ADR-014: structural/identity-pattern change).
- Downstream modules do not require IRI changes; they may optionally adopt new types.
- Old keys, old enumerations, and single-value relations will be deprecated (not silently replaced). A migration guide will accompany v2.0.0.

## Cross-module impact

| Downstream module | References | Impact of v2.0.0 |
|---|---|---|
| instruments | 11 | None (IRIs retained) |
| market-data | 4 | None |
| market-rules | 11 | None |
| market-structure | 20 | None (may adopt BusinessCalendar interface) |
| orders-execution | 18 | None |
| portfolio-positions | 18 | None |
| post-trade-operations | 76 | None |
| risk | 5 | None |
| strategy-research | 8 | None |

## Sidecar fixes (non-breaking, accompany v2.0.0)

1. **CQ**: `fin-foundation-cq.yaml` version 0.3.0 → 2.0.0; CQ-F1 reworded; CQ-F4 `IdentifierAssignment` → `FinancialIdentifierAssignment`; CQ-F2/F3 enriched.
2. **Terminology**: `fin-foundation-terms.yaml` removes orphan `MonetaryAmount` / `QuantityValue` / `hasCurrencyCode` (these belong to M3).
3. **Gap doc**: `foundation-semantic-gap.md` records reopened gaps closed by v2.0.0.
4. **M2-PLAN**: §5.2 foundation row updated to reflect BusinessCalendar interface decision.

## References

- [ISO 6166:2021](https://www.iso.org/standard/78502.html) — ISIN covers financial instruments and referential instruments
- [ISO 17442-1:2020](https://www.iso.org/standard/59771.html) — LEI structure and check digits
- [ISO 10383:2012](https://www.iso.org/standard/62067.html) — MIC (Operating vs Segment)
- [SIX ISO 4217](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html) — Currency/fund/historical lists, N.A. minor unit
- [GLEIF LEI-CDF](https://www.gleif.org/en/lei-data/access-and-use-lei-data/level-1-data-lei-cdf-3-1-format) — LEI reference data beyond 20-char string
- [FIBO Currency](https://spec.edmcouncil.org/fibo/ontology/FND/Accounting/CurrencyAmount/Currency) — Currency vs CurrencyIdentifier separation
- [W3C ORG](https://www.w3.org/TR/vocab-org/) — Organization-role-temporal relationship pattern
- [ISO 20022 Cash Account](https://www.iso20022.org/) — Account/identifier/owner/servicer separation
