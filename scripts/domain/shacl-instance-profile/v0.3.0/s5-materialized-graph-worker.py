"""Closed pySHACL worker for the S5 materialized-graph evidence chain."""

import builtins
import hashlib
import json
import socket
import sys
import urllib.request

import pyshacl
import rdflib
from pyshacl import validate

EXPECTED_PYSHACL = "0.26.0"
EXPECTED_RDFLIB = "7.6.0"


def denied(*_args, **_kwargs):
    raise PermissionError("network access is denied by the S5 SHACL worker")


socket.socket = denied
socket.create_connection = denied
urllib.request.urlopen = denied


def term(value):
    if value is None:
        return None
    return value.n3()


def main():
    if pyshacl.__version__ != EXPECTED_PYSHACL:
        raise RuntimeError(f"pySHACL version drift: {pyshacl.__version__}")
    if rdflib.__version__ != EXPECTED_RDFLIB:
        raise RuntimeError(f"RDFLib version drift: {rdflib.__version__}")
    request_bytes = sys.stdin.buffer.read()
    request = json.loads(request_bytes.decode("utf-8"))
    if sorted(request) != ["dataNQuads", "schemaVersion", "shapesTurtle"]:
        raise ValueError("request differs from the closed S5 SHACL protocol")
    if request["schemaVersion"] != "1.0":
        raise ValueError("unsupported protocol version")

    dataset = rdflib.ConjunctiveGraph()
    dataset.parse(data=request["dataNQuads"], format="nquads")
    data = rdflib.Graph()
    for subject, predicate, value, _context in dataset.quads((None, None, None, None)):
        data.add((subject, predicate, value))
    shapes = rdflib.Graph()
    shapes.parse(data=request["shapesTurtle"], format="turtle")
    conforms, report_graph, _report_text = validate(
        data_graph=data,
        shacl_graph=shapes,
        inference="none",
        abort_on_first=False,
        allow_infos=False,
        allow_warnings=False,
        meta_shacl=False,
        advanced=True,
        js=False,
        iterate_rules=False,
        inplace=False,
        do_owl_imports=False,
    )
    SH = rdflib.Namespace("http://www.w3.org/ns/shacl#")
    result_rows = []
    for result in report_graph.subjects(rdflib.RDF.type, SH.ValidationResult):
        messages = sorted(str(value) for value in report_graph.objects(result, SH.resultMessage))
        result_rows.append({
            "focusNode": term(report_graph.value(result, SH.focusNode)),
            "resultPath": term(report_graph.value(result, SH.resultPath)),
            "sourceConstraintComponent": term(report_graph.value(result, SH.sourceConstraintComponent)),
            "sourceShape": term(report_graph.value(result, SH.sourceShape)),
            "severity": term(report_graph.value(result, SH.resultSeverity)),
            "value": term(report_graph.value(result, SH.value)),
            "messages": messages,
        })
    result_rows.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    response = {
        "schemaVersion": "1.0",
        "conforms": bool(conforms),
        "engine": {
            "name": "pyshacl",
            "version": pyshacl.__version__,
            "rdfEngine": "rdflib",
            "rdfEngineVersion": rdflib.__version__,
            "network": "denied-in-process",
            "inference": "none",
            "owlImports": False,
            "rules": False,
            "js": False,
        },
        "resultCount": len(result_rows),
        "results": result_rows,
        "requestDigest": "sha256:" + hashlib.sha256(request_bytes).hexdigest(),
    }
    sys.stdout.write(json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as cause:  # closed fail-closed protocol
        sys.stderr.write(f"{type(cause).__name__}: {cause}\n")
        sys.exit(1)
