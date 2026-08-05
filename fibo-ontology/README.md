# FIBO Ontology Mirror

Complete local mirror of [EDMC FIBO](https://github.com/edmcouncil/fibo) from `reference/ontology-design-reference/fibo/`, organized in Axiolune typed-container authoring format (`*.module.yaml`).

## Contents

- Original FIBO RDF/source files copied verbatim under this tree
- One ontology-specific `*.module.yaml` per FIBO RDF file (`objectTypes`, `relationTypes`, `attributeTypes`)
- `module-registry.yaml` index of all generated modules

## Stats (generated)

- RDF files copied: 295
- module.yaml generated: 295
- object types: 3130
- relation types: 934
- attribute types: 261
- parse failures: 0

## Regenerate

```bash
python scripts/fibo/import-fibo-ontology.py
node fibo-visualization/generate.cjs
```

## Visualization

Open `fibo-visualization/index.html` after regeneration.
