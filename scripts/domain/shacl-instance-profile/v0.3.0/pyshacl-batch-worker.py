#!/usr/bin/env python3
"""Pinned, no-import batch executor for isolated M2 SHACL instance fixtures."""

from __future__ import annotations

import hashlib
import json
import socket
import sys
import urllib.request
from typing import Any

import pyshacl
import rdflib
from pyshacl import validate
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF, SH, XSD


EXPECTED_PYSHACL_VERSION = "0.26.0"
EXPECTED_RDFLIB_VERSION = "7.6.0"
MAX_CASE_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 128 * 1024 * 1024
JSON_SAFE_INTEGER = 9_007_199_254_740_991


class NetworkAccessDenied(RuntimeError):
    """Raised by the release worker's in-process no-network boundary."""


def _deny_network(*_args: Any, **_kwargs: Any) -> None:
    raise NetworkAccessDenied("network access denied by m2-shacl-worker-v1")


def install_and_verify_network_guard() -> dict[str, Any]:
    socket.socket = _deny_network  # type: ignore[assignment]
    socket.create_connection = _deny_network  # type: ignore[assignment]
    socket.getaddrinfo = _deny_network  # type: ignore[assignment]
    urllib.request.urlopen = _deny_network  # type: ignore[assignment]
    probes = {}
    for probe, operation in (
        ("socketConstructorProbe", lambda: socket.socket()),
        ("urlopenProbe", lambda: urllib.request.urlopen("http://127.0.0.1:9/")),
    ):
        try:
            operation()
        except NetworkAccessDenied:
            probes[probe] = "denied"
        else:
            raise RuntimeError(f"no-network self-test unexpectedly allowed {probe}")
    return {
        "guard": "python-socket-urllib-v1",
        "network": "denied-in-process",
        "socketConstructorProbe": probes["socketConstructorProbe"],
        "urlopenProbe": probes["urlopenProbe"],
        "inference": "none",
        "js": False,
        "owlImports": False,
        "rules": False,
    }


def exact_keys(value: Any, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value.keys()) != expected:
        raise ValueError(f"{label} differs from its closed schema")


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, member in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON member: {key}")
        value[key] = member
    return value


def _utf16_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="strict")


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > JSON_SAFE_INTEGER:
            raise ValueError("JSON integer exceeds the interoperable safe range")
        return str(value)
    if isinstance(value, float):
        raise ValueError("floating-point JSON values are outside this closed worker protocol")
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(member) for member in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings")
        return "{" + ",".join(
            f"{canonical_json(key)}:{canonical_json(value[key])}"
            for key in sorted(value.keys(), key=_utf16_key)
        ) + "}"
    raise ValueError(f"unsupported JSON value type: {type(value).__name__}")


def read_exact_jcs_request() -> Any:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError(f"request exceeds {MAX_REQUEST_BYTES} bytes")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as cause:
        raise ValueError("request is not exact UTF-8") from cause
    request = json.loads(text, object_pairs_hook=_closed_object)
    canonical = canonical_json(request).encode("utf-8")
    if raw != canonical:
        raise ValueError("request bytes are not exact RFC 8785 JCS")
    return request


def sha256_bytes(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def term_text(value: rdflib.term.Node | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, Literal):
        serialized = value._literal_n3(use_plain=False)
        # RDF 1.1 plain string syntax denotes xsd:string.  pySHACL may copy an
        # explicitly typed input focus into its report as a plain Literal, so
        # normalize both representations to one exact RDF-term spelling.
        if value.language is None and value.datatype is None:
            return f"{serialized}^^<{XSD.string}>"
        return serialized
    return value.n3(namespace_manager=None)


def one_object(graph: Graph, subject: rdflib.term.Node, predicate: URIRef) -> rdflib.term.Node | None:
    values = list(graph.objects(subject, predicate))
    if len(values) > 1:
        raise ValueError(f"result {subject.n3()} repeats {predicate.n3()}")
    return values[0] if values else None


def result_record(graph: Graph, result: rdflib.term.Node, seen: set[str]) -> dict[str, Any]:
    key = result.n3(namespace_manager=None)
    if key in seen:
        raise ValueError("sh:detail graph is cyclic")
    seen.add(key)
    details = [result_record(graph, child, seen) for child in graph.objects(result, SH.detail)]
    details.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    record = {
        "focusNode": term_text(one_object(graph, result, SH.focusNode)),
        "resultPath": term_text(one_object(graph, result, SH.resultPath)),
        "sourceConstraintComponent": str(one_object(graph, result, SH.sourceConstraintComponent) or ""),
        "resultSeverity": str(one_object(graph, result, SH.resultSeverity) or ""),
        "sourceShape": term_text(one_object(graph, result, SH.sourceShape)),
        "value": term_text(one_object(graph, result, SH.value)),
        "details": details,
    }
    seen.remove(key)
    return record


CASE_FIELDS = {
    "fixtureId", "constraintInstanceId", "emittedBy", "shapeRef",
    "shapeDigest", "shapeNQuads", "dataDigest", "dataNQuads",
    "focusNode", "expectedPath", "expectedComponent", "expectedSeverity",
    "expectedResult",
}


def validate_case(case: Any, polarity: str, label: str) -> None:
    exact_keys(case, CASE_FIELDS, label)
    expected = "conforms" if polarity == "positive" else "violates"
    if case["expectedResult"] != expected:
        raise ValueError(f"{label}.expectedResult must be {expected}")
    if not isinstance(case["fixtureId"], str) or not isinstance(case["constraintInstanceId"], str):
        raise ValueError(f"{label} IDs must be strings")
    if not isinstance(case["shapeNQuads"], str) or not isinstance(case["dataNQuads"], str):
        raise ValueError(f"{label} RDF artifacts must be strings")
    if len(case["shapeNQuads"].encode("utf-8")) > MAX_CASE_BYTES or len(case["dataNQuads"].encode("utf-8")) > MAX_CASE_BYTES:
        raise ValueError(f"{label} exceeds the fixed per-case byte limit")
    if sha256_bytes(case["shapeNQuads"]) != case["shapeDigest"]:
        raise ValueError(f"{label}.shapeDigest mismatch")
    if sha256_bytes(case["dataNQuads"]) != case["dataDigest"]:
        raise ValueError(f"{label}.dataDigest mismatch")


def execute_case(case: dict[str, Any], polarity: str) -> dict[str, Any]:
    try:
        data_graph = Graph()
        data_graph.parse(data=case["dataNQuads"], format="nt")
        shapes_graph = Graph()
        shapes_graph.parse(data=case["shapeNQuads"], format="nt")
        conforms, report_graph, _report_text = validate(
            data_graph=data_graph,
            shacl_graph=shapes_graph,
            ont_graph=None,
            inference="none",
            abort_on_first=False,
            allow_infos=False,
            allow_warnings=False,
            meta_shacl=False,
            advanced=False,
            js=False,
            debug=False,
            do_owl_imports=False,
            iterate_rules=False,
            serialize_report_graph=False,
        )
        roots = list(report_graph.objects(None, SH.result))
        records = [result_record(report_graph, root, set()) for root in roots]
        records.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return {
            "fixtureId": case["fixtureId"],
            "constraintInstanceId": case["constraintInstanceId"],
            "polarity": polarity,
            "outcome": "conforms" if bool(conforms) else "violates",
            "rootResultCount": len(roots),
            "results": records,
            "engineError": None,
        }
    except Exception as cause:  # pySHACL/parser failures are evidence, never PASS.
        message = f"{type(cause).__name__}: {cause}"
        return {
            "fixtureId": case["fixtureId"],
            "constraintInstanceId": case["constraintInstanceId"],
            "polarity": polarity,
            "outcome": "engineFailure",
            "rootResultCount": 0,
            "results": [],
            "engineError": {
                "type": type(cause).__name__,
                "message": message,
                "causeDigest": sha256_bytes(message),
            },
        }


AGGREGATE_FIELDS = {
    "schemaVersion", "profileRef", "artifactKind", "polarity",
    "rdfCanonicalization", "rdfCanonicalizer", "cases",
}


def validate_aggregate(value: Any, polarity: str) -> None:
    exact_keys(value, AGGREGATE_FIELDS, polarity)
    if value["schemaVersion"] != "1.0" or value["polarity"] != polarity:
        raise ValueError(f"{polarity} aggregate header drift")
    if value["rdfCanonicalization"] != "RDFC-1.0" or not isinstance(value["cases"], list):
        raise ValueError(f"{polarity} aggregate is not canonical RDFC fixture input")
    previous = None
    for index, case in enumerate(value["cases"]):
        validate_case(case, polarity, f"{polarity}.cases[{index}]")
        if previous is not None and case["constraintInstanceId"] <= previous:
            raise ValueError(f"{polarity} cases are not constraintInstanceId-sorted and unique")
        previous = case["constraintInstanceId"]


def main() -> int:
    if pyshacl.__version__ != EXPECTED_PYSHACL_VERSION:
        raise RuntimeError(
            f"pySHACL must be exactly {EXPECTED_PYSHACL_VERSION}; found {pyshacl.__version__}"
        )
    if rdflib.__version__ != EXPECTED_RDFLIB_VERSION:
        raise RuntimeError(
            f"RDFLib must be exactly {EXPECTED_RDFLIB_VERSION}; found {rdflib.__version__}"
        )
    permission_assurance = install_and_verify_network_guard()
    request = read_exact_jcs_request()
    exact_keys(request, {"schemaVersion", "positive", "negative"}, "request")
    if request["schemaVersion"] != "1.0":
        raise ValueError("request.schemaVersion must be 1.0")
    validate_aggregate(request["positive"], "positive")
    validate_aggregate(request["negative"], "negative")
    positive_ids = [row["constraintInstanceId"] for row in request["positive"]["cases"]]
    negative_ids = [row["constraintInstanceId"] for row in request["negative"]["cases"]]
    if positive_ids != negative_ids:
        raise ValueError("positive and negative aggregate instance sets differ")
    results = []
    for polarity in ("positive", "negative"):
        for case in request[polarity]["cases"]:
            results.append(execute_case(case, polarity))
    output = {
        "schemaVersion": "1.0",
        "engine": "pyshacl",
        "engineVersion": pyshacl.__version__,
        "rdfEngine": "rdflib",
        "rdfEngineVersion": rdflib.__version__,
        "permissionAssurance": permission_assurance,
        "results": results,
    }
    sys.stdout.write(canonical_json(output))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as cause:
        sys.stderr.write(f"{type(cause).__name__}: {cause}\n")
        raise SystemExit(2)
