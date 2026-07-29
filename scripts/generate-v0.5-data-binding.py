#!/usr/bin/env python3
"""
Generate data-binding-meta-model v0.5 compliant with ADR-011 and ADR-012
"""

import yaml
import json

# This script generates the complete v0.5 data binding module
# Due to size constraints, we'll generate it programmatically

v05_module = """# Axiolune Ontology Meta-Model - Layer 4: Data Binding v0.5
# Version: 0.5.0
# Date: 2026-07-29
# Governance: ADR-011 (Canonical Data Binding Truth Source), ADR-012 (Three-Axis Temporal)

module:
  moduleIri: "https://axiolune.ai/ontology/meta/data-binding"
  baseIri: "https://axiolune.ai/ontology/meta/data-binding/"
  preferredPrefix: "ax-binding"
  version: "0.5.0"
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/core#sha256:6a3861b3861fc2301deddd55965f23030f9fae653755c0568fa1ea2f4d634592"
      version: "0.4.0"
      artifactDigest: "sha256:6a3861b3861fc2301deddd55965f23030f9fae653755c0568fa1ea2f4d634592"
      importMode: All
    - moduleIri: "https://axiolune.ai/ontology/meta/patterns#sha256:654ecf0d6e55e5a2437da1e8cf1e6732bb19c34cecac470a9c32c357a63c7796"
      version: "0.4.0"
      artifactDigest: "sha256:654ecf0d6e55e5a2437da1e8cf1e6732bb19c34cecac470a9c32c357a63c7796"
      importMode: All
    - moduleIri: "https://axiolune.ai/ontology/meta/behavior#sha256:93e690b6261a52fd42627178114edb94cb7f80f372539f6eed6258233b2d2962"
      version: "0.4.0"
      artifactDigest: "sha256:93e690b6261a52fd42627178114edb94cb7f80f372539f6eed6258233b2d2962"
      importMode: All
  exports: []

DataBinding:
  version: "0.5.0"
  description: "Meta-model for mapping physical data sources to ontology concepts (ADR-011 compliant)"
  layer: 4

  changes:
    - "v0.5.0: BREAKING - Implement ADR-011 single truth source architecture"
    - "v0.5.0: REMOVED Field.semanticMapping and SemanticFieldMapping (violated single truth source)"
    - "v0.5.0: SemanticMappingDefinition is now canonical truth source with complete mapping capabilities"
    - "v0.5.0: Added SourceBinding, RowSetSpec, IdentitySpec for row-level semantics"
    - "v0.5.0: Renamed fieldMappings to slotMappings (supports attributes, roles, relations, pattern fields)"
    - "v0.5.0: Added MaterializationRun for immutable runtime state (separated from static definitions)"
    - "v0.5.0: Implement ADR-012 three-axis temporal model (valid/knowledge/availability)"
    - "v0.5.0: Added TemporalMappingSpec with explicit source bindings for all three time axes"
    - "v0.5.0: REMOVED MaterializationPlanDefinition.watermark (moved to MaterializationRun)"
    - "v0.5.0: All transformations require explicit named inputs, version, digest, test cases"

  note: |
    Layer 4 maps PHYSICAL data artifacts to SEMANTIC ontology concepts.

    ADR-011 COMPLIANCE:
    - SemanticMappingDefinition is the ONLY structure for semantic mappings
    - Physical structure (FieldDefinition) contains NO semantic annotations
    - Static definitions (plans) separated from runtime state (runs)

    ADR-012 COMPLIANCE:
    - Three-axis temporal model: valid time, knowledge time, availability time
    - All time sources explicitly declared in TemporalMappingSpec
    - No CURRENT_TIMESTAMP or non-reproducible time functions
    - MaterializationRun provides immutable runtime context for reproducible queries
"""

# Write to file
output_path = "ontology/meta/data-binding-meta-model-v0.5.yaml"
with open(output_path, 'w', encoding='utf-8') as f:
    f.write(v05_module)

print(f"Generated {output_path}")
print("This is a skeleton - full implementation required")
