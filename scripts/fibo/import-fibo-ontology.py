#!/usr/bin/env python3
"""Import local FIBO reference bundle into fibo-ontology/ as Axiolune-style module.yaml."""

from __future__ import annotations

import hashlib
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

ROOT = Path(__file__).resolve().parents[2]
FIBO_SRC = ROOT / "reference" / "ontology-design-reference" / "fibo"
FIBO_OUT = ROOT / "fibo-ontology"

OWL_CLASS = OWL.Class
OWL_OBJECT_PROP = OWL.ObjectProperty
OWL_DATATYPE_PROP = OWL.DatatypeProperty
OWL_ONTOLOGY = OWL.Ontology
OWL_DEPRECATED = OWL.deprecated
OWL_INVERSE_OF = OWL.inverseOf
RDF_TYPE = RDF.type
RDFS_SUBCLASS = RDFS.subClassOf
RDFS_SUBPROP = RDFS.subPropertyOf
RDFS_LABEL = RDFS.label
RDFS_COMMENT = RDFS.comment
RDFS_DOMAIN = RDFS.domain
RDFS_RANGE = RDFS.range
SKOS_DEFINITION = SKOS.definition
DCT = Namespace("http://purl.org/dc/terms/")
DCT_ABSTRACT = DCT.abstract

SKIP_DIRS = {".github", "__pycache__"}
COPY_SUFFIXES = {".rdf", ".md", ".ttl", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv"}

DOMAIN_COLORS = {
    "ACTUS": "#6366f1",
    "BE": "#0ea5e9",
    "BP": "#14b8a6",
    "CAE": "#22c55e",
    "DER": "#eab308",
    "EXMP": "#f97316",
    "FBC": "#ef4444",
    "FND": "#8b5cf6",
    "IND": "#ec4899",
    "LOAN": "#06b6d4",
    "MD": "#84cc16",
    "SEC": "#3b82f6",
    "etc": "#64748b",
}


def str_val(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, Literal):
        return str(node)
    return str(node)


def local_name(iri: str) -> str:
    iri = iri.rstrip("/#")
    if "#" in iri:
        return iri.rsplit("#", 1)[-1]
    return iri.rsplit("/", 1)[-1]


def prefix_from_iri(iri: str) -> str:
    parts = [p for p in iri.replace("https://", "").replace("http://", "").split("/") if p]
    if len(parts) >= 4 and parts[0] == "spec.edmcouncil.org" and parts[1] == "fibo":
        domain = parts[3].lower()
        tail = "".join(p[:3].lower() for p in parts[4:6]) if len(parts) > 4 else domain[:3]
        return f"fibo-{domain}-{tail}"[:24].rstrip("-")
    return "fibo"


def pick_literal(g: Graph, subject: URIRef, *predicates) -> str:
    for pred in predicates:
        for obj in g.objects(subject, pred):
            text = str_val(obj).strip()
            if text:
                return text
    return ""


def is_deprecated(g: Graph, subject: URIRef) -> bool:
    for obj in g.objects(subject, OWL_DEPRECATED):
        val = str_val(obj).lower()
        if val in {"true", "1"}:
            return True
    return False


def literal_label(g: Graph, subject: URIRef) -> str:
    return pick_literal(g, subject, RDFS_LABEL, SKOS.prefLabel)


def literal_definition(g: Graph, subject: URIRef) -> str:
    return pick_literal(g, subject, SKOS_DEFINITION, RDFS_COMMENT, DCT_ABSTRACT)


def version_from_graph(g: Graph, ontology_iri: URIRef | None) -> str:
    if ontology_iri is not None:
        for obj in g.objects(ontology_iri, OWL.versionIRI):
            text = str_val(obj)
            match = re.search(r"/(\d{8})/", text)
            if match:
                return match.group(1)
            match = re.search(r"/(\d{4}Q[1-4])/", text)
            if match:
                return match.group(1)
    return "local"


def ontology_imports(g: Graph, ontology_iri: URIRef | None) -> list[dict[str, str]]:
    imports: list[dict[str, str]] = []
    if ontology_iri is None:
        return imports
    seen: set[str] = set()
    for obj in g.objects(ontology_iri, OWL.imports):
        iri = str_val(obj).strip()
        if not iri or iri in seen:
            continue
        seen.add(iri)
        imports.append({"moduleIri": iri, "version": "external"})
    return imports


def direct_superclasses(g: Graph, cls: URIRef) -> list[str]:
    supers: list[str] = []
    for obj in g.objects(cls, RDFS_SUBCLASS):
        if isinstance(obj, URIRef):
            supers.append(str(obj))
    return supers


def property_domain_range(g: Graph, prop: URIRef) -> tuple[str, str]:
    domain = ""
    range_ = ""
    for obj in g.objects(prop, RDFS_DOMAIN):
        if isinstance(obj, URIRef):
            domain = str(obj)
            break
    for obj in g.objects(prop, RDFS_RANGE):
        if isinstance(obj, URIRef):
            range_ = str(obj)
            break
    return domain, range_


def map_value_type(range_iri: str) -> str:
    mapping = {
        str(XSD.string): "string",
        str(XSD.anyURI): "uri",
        str(XSD.decimal): "decimal",
        str(XSD.integer): "integer",
        str(XSD.int): "integer",
        str(XSD.nonNegativeInteger): "integer",
        str(XSD.positiveInteger): "integer",
        str(XSD.boolean): "boolean",
        str(XSD.date): "date",
        str(XSD.dateTime): "instant",
        str(XSD.duration): "duration",
    }
    if range_iri in mapping:
        return mapping[range_iri]
    if range_iri.startswith("http://www.w3.org/2001/XMLSchema#"):
        return local_name(range_iri)
    return range_iri or "any"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def convert_rdf_file(src_rdf: Path, rel: Path) -> dict[str, Any] | None:
    g = Graph()
    try:
        g.parse(src_rdf.as_posix(), format="xml")
    except Exception as exc:  # noqa: BLE001 - collect and continue
        print(f"WARN parse failed: {rel} ({exc})", file=sys.stderr)
        return None

    ontology_iri: URIRef | None = None
    for s, _, o in g.triples((None, RDF_TYPE, OWL_ONTOLOGY)):
        if isinstance(s, URIRef):
            ontology_iri = s
            break
    if ontology_iri is None:
        for s in g.subjects(RDF_TYPE, OWL_ONTOLOGY):
            if isinstance(s, URIRef):
                ontology_iri = s
                break

    if ontology_iri is None:
        base = src_rdf.stem
        parent = rel.parent.as_posix().strip("/")
        ontology_iri = URIRef(f"https://spec.edmcouncil.org/fibo/ontology/{parent}/{base}/")

    module_iri = str(ontology_iri).rstrip("/") + "/"
    ns = module_iri
    pref = prefix_from_iri(module_iri)
    domain_key = rel.parts[0] if rel.parts else "etc"

    module = {
        "moduleIri": module_iri,
        "baseIri": ns,
        "preferredPrefix": pref,
        "version": version_from_graph(g, ontology_iri),
        "label": pick_literal(g, ontology_iri, RDFS_LABEL) or local_name(module_iri.rstrip("/")),
        "definition": pick_literal(g, ontology_iri, DCT_ABSTRACT, RDFS_COMMENT, SKOS_DEFINITION)
        or f"FIBO ontology module imported from {rel.as_posix()}",
        "imports": ontology_imports(g, ontology_iri),
        "exports": [],
        "status": "reference",
        "governance": {
            "ownerRef": "urn:axiolune:authority:fibo-edmcouncil",
            "status": "reference",
        },
        "sourceArtifact": rel.name,
        "sourceDigest": sha256_file(src_rdf),
        "sourcePath": rel.as_posix(),
        "fiboDomain": domain_key,
    }

    object_types: dict[str, Any] = {}
    relation_types: dict[str, Any] = {}
    attribute_types: dict[str, Any] = {}

    for cls in g.subjects(RDF_TYPE, OWL_CLASS):
        if not isinstance(cls, URIRef):
            continue
        if str(cls) == str(ontology_iri):
            continue
        if is_deprecated(g, cls):
            continue
        name = local_name(str(cls))
        if not name or name.startswith("_"):
            continue
        object_types[name] = {
            "iri": str(cls),
            "namespace": pref,
            "localName": name,
            "label": literal_label(g, cls) or name,
            "definition": literal_definition(g, cls),
            "superTypes": direct_superclasses(g, cls),
            "attributeUses": [],
            "patternBindings": [],
        }

    for prop in g.subjects(RDF_TYPE, OWL_OBJECT_PROP):
        if not isinstance(prop, URIRef):
            continue
        if is_deprecated(g, prop):
            continue
        name = local_name(str(prop))
        if not name:
            continue
        domain, range_ = property_domain_range(g, prop)
        inverse_of = ""
        for obj in g.objects(prop, OWL_INVERSE_OF):
            if isinstance(obj, URIRef):
                inverse_of = str(obj)
                break
        relation_types[name] = {
            "iri": str(prop),
            "namespace": pref,
            "localName": name,
            "label": literal_label(g, prop) or name,
            "definition": literal_definition(g, prop),
            "domain": domain,
            "range": range_,
            "inverseOf": inverse_of,
            "characteristics": [],
        }

    for prop in g.subjects(RDF_TYPE, OWL_DATATYPE_PROP):
        if not isinstance(prop, URIRef):
            continue
        if is_deprecated(g, prop):
            continue
        name = local_name(str(prop))
        if not name:
            continue
        _, range_ = property_domain_range(g, prop)
        attribute_types[name] = {
            "iri": str(prop),
            "namespace": pref,
            "localName": name,
            "label": literal_label(g, prop) or name,
            "definition": literal_definition(g, prop),
            "valueType": map_value_type(range_),
            "defaultCardinality": {"minCount": 0, "maxCount": None},
        }

    doc = {
        "module": module,
        "domain": {
            "objectTypes": object_types,
            "associationTypes": {},
            "relationTypes": relation_types,
            "attributeTypes": attribute_types,
            "identifierTypes": {},
            "codeLists": {},
            "constraints": {},
        },
    }
    return doc


def should_copy(path: Path) -> bool:
    if path.is_dir():
        return path.name not in SKIP_DIRS
    return path.suffix.lower() in COPY_SUFFIXES or path.name in {
        "LICENSE",
        "DCO",
        "CONTRIBUTING.md",
        "ONTOLOGY_GUIDE.md",
        "CODE_OF_CONDUCT.md",
    }


def copy_fibo_tree() -> list[Path]:
    copied_rdf: list[Path] = []
    if FIBO_OUT.exists():
        shutil.rmtree(FIBO_OUT)
    FIBO_OUT.mkdir(parents=True)

    for src in sorted(FIBO_SRC.rglob("*")):
        rel = src.relative_to(FIBO_SRC)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if src.is_dir():
            continue
        if not should_copy(src):
            continue
        dest = FIBO_OUT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        if src.suffix.lower() == ".rdf":
            copied_rdf.append(rel)
    return copied_rdf


def write_module_yaml(rel: Path, doc: dict[str, Any]) -> None:
    stem = rel.stem
    out = FIBO_OUT / rel.parent / f"{stem}.module.yaml"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        yaml.safe_dump(
            doc,
            handle,
            sort_keys=False,
            allow_unicode=True,
            width=120,
            default_flow_style=False,
        )


def build_registry(entries: list[dict[str, Any]]) -> None:
    registry = {
        "registry": {
            "label": "FIBO Local Mirror Registry",
            "description": "Complete local mirror of reference/ontology-design-reference/fibo in Axiolune module.yaml format.",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceRoot": "reference/ontology-design-reference/fibo",
            "moduleCount": len(entries),
            "domainColors": DOMAIN_COLORS,
            "modules": entries,
        }
    }
    out = FIBO_OUT / "module-registry.yaml"
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        yaml.safe_dump(registry, handle, sort_keys=False, allow_unicode=True, width=120)


def write_readme(stats: dict[str, int]) -> None:
    readme = f"""# FIBO Ontology Mirror

Complete local mirror of [EDMC FIBO](https://github.com/edmcouncil/fibo) from `reference/ontology-design-reference/fibo/`, organized in Axiolune typed-container authoring format (`*.module.yaml`).

## Contents

- Original FIBO RDF/source files copied verbatim under this tree
- One ontology-specific `*.module.yaml` per FIBO RDF file (`objectTypes`, `relationTypes`, `attributeTypes`)
- `module-registry.yaml` index of all generated modules

## Stats (generated)

- RDF files copied: {stats['rdf_files']}
- module.yaml generated: {stats['modules']}
- object types: {stats['object_types']}
- relation types: {stats['relation_types']}
- attribute types: {stats['attribute_types']}
- parse failures: {stats['parse_failures']}

## Regenerate

```bash
python scripts/fibo/import-fibo-ontology.py
node fibo-visualization/generate.cjs
```

## Visualization

Open `fibo-visualization/index.html` after regeneration.
"""
    (FIBO_OUT / "README.md").write_text(readme, encoding="utf-8", newline="\n")


def main() -> int:
    if not FIBO_SRC.is_dir():
        print(f"Missing FIBO source: {FIBO_SRC}", file=sys.stderr)
        return 1

    print(f"Copying FIBO from {FIBO_SRC} -> {FIBO_OUT}")
    rdf_files = copy_fibo_tree()
    print(f"Copied {len(rdf_files)} RDF files")

    stats = {
        "rdf_files": len(rdf_files),
        "modules": 0,
        "object_types": 0,
        "relation_types": 0,
        "attribute_types": 0,
        "parse_failures": 0,
    }
    registry_entries: list[dict[str, Any]] = []

    for rel in rdf_files:
        src = FIBO_OUT / rel
        doc = convert_rdf_file(src, rel)
        if doc is None:
            stats["parse_failures"] += 1
            continue
        write_module_yaml(rel, doc)
        stats["modules"] += 1
        domain = doc["module"]
        obj_count = len(doc["domain"]["objectTypes"])
        rel_count = len(doc["domain"]["relationTypes"])
        attr_count = len(doc["domain"]["attributeTypes"])
        stats["object_types"] += obj_count
        stats["relation_types"] += rel_count
        stats["attribute_types"] += attr_count
        registry_entries.append(
            {
                "moduleIri": domain["moduleIri"],
                "label": domain["label"],
                "version": domain["version"],
                "fiboDomain": domain.get("fiboDomain"),
                "sourcePath": domain["sourcePath"],
                "moduleYaml": (rel.parent / f"{rel.stem}.module.yaml").as_posix(),
                "counts": {
                    "objectTypes": obj_count,
                    "relationTypes": rel_count,
                    "attributeTypes": attr_count,
                },
            }
        )

    registry_entries.sort(key=lambda item: item["moduleIri"])
    build_registry(registry_entries)
    write_readme(stats)

    print("Import complete:")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    print(f"Registry: {FIBO_OUT / 'module-registry.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
