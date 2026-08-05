# FIBO Visualization

Interactive graph explorer for the complete local FIBO mirror under `fibo-ontology/`.

## Generate

```bash
python scripts/fibo/import-fibo-ontology.py
node fibo-visualization/generate.cjs
node fibo-visualization/assert-projection.cjs
```

## View

Open `fibo-visualization/index.html` in a browser (offline-capable; data is embedded).

## Outputs

| File | Purpose |
|------|---------|
| `data.json` | Projected graph (structural-v2) |
| `index.html` | Bundled UI with embedded data |
| `template.html` | UI shell (inlined at generate time) |
| `generate.cjs` | Reads `fibo-ontology/**/*.module.yaml` |
| `assert-projection.cjs` | Smoke checks for FIBO-scale graph |
