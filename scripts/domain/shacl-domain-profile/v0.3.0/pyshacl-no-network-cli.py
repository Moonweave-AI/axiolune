#!/usr/bin/env python3
"""Pinned pySHACL CLI boundary with an in-process no-network guard."""

from __future__ import annotations

import json
import os
import platform
import socket
import sys
import urllib.request
from typing import Any


EXPECTED_PYSHACL_VERSION = "0.26.0"
EXPECTED_RDFLIB_VERSION = "7.6.0"
NETWORK_ATTEMPTED = False


class NetworkAccessDenied(RuntimeError):
    """Raised whenever validation code attempts network access."""


def _deny_network(*_args: Any, **_kwargs: Any) -> None:
    global NETWORK_ATTEMPTED
    NETWORK_ATTEMPTED = True
    raise NetworkAccessDenied("network access denied by m2-domain-shacl-worker-v1")


def install_and_verify_network_guard() -> dict[str, Any]:
    global NETWORK_ATTEMPTED
    socket.socket = _deny_network  # type: ignore[assignment]
    socket.create_connection = _deny_network  # type: ignore[assignment]
    socket.getaddrinfo = _deny_network  # type: ignore[assignment]
    urllib.request.urlopen = _deny_network  # type: ignore[assignment]
    probes: dict[str, str] = {}
    for name, operation in (
        ("socketConstructorProbe", lambda: socket.socket()),
        ("urlopenProbe", lambda: urllib.request.urlopen("http://127.0.0.1:9/")),
    ):
        try:
            operation()
        except NetworkAccessDenied:
            probes[name] = "denied"
        else:
            raise RuntimeError(f"no-network self-test unexpectedly allowed {name}")
    NETWORK_ATTEMPTED = False
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


def runtime_attestation(permission_assurance: dict[str, Any]) -> dict[str, Any]:
    import pyshacl
    import rdflib

    if pyshacl.__version__ != EXPECTED_PYSHACL_VERSION:
        raise RuntimeError(
            f"pySHACL {pyshacl.__version__} does not equal {EXPECTED_PYSHACL_VERSION}"
        )
    if rdflib.__version__ != EXPECTED_RDFLIB_VERSION:
        raise RuntimeError(
            f"RDFLib {rdflib.__version__} does not equal {EXPECTED_RDFLIB_VERSION}"
        )
    return {
        "permissionAssurance": permission_assurance,
        "pyshaclEntry": pyshacl.__file__,
        "pyshaclVersion": pyshacl.__version__,
        "pythonExecutable": sys.executable,
        "pythonVersion": platform.python_version(),
        "rdflibEntry": rdflib.__file__,
        "rdflibVersion": rdflib.__version__,
    }


def validate_closed_cli(arguments: list[str]) -> None:
    if len(arguments) == 5 and arguments[:3] == ["-f", "nt", "-s"]:
        shapes_path, data_path = arguments[3], arguments[4]
    elif len(arguments) == 3 and arguments[0] == "-s":
        shapes_path, data_path = arguments[1], arguments[2]
    else:
        raise ValueError(
            "closed SHACL worker accepts only "
            "[-f nt] -s <absolute-shapes-file> <absolute-data-file>"
        )
    for label, value in (("shapes", shapes_path), ("data", data_path)):
        if not os.path.isabs(value) or not os.path.isfile(value):
            raise ValueError(f"{label} must be an existing absolute regular-file path")


def main() -> None:
    global NETWORK_ATTEMPTED
    permission_assurance = install_and_verify_network_guard()
    attestation = runtime_attestation(permission_assurance)
    if sys.argv[1:] == ["--self-test"]:
        print(
            json.dumps(
                attestation,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return
    try:
        validate_closed_cli(sys.argv[1:])
    except ValueError as cause:
        print(f"closed-worker-argument-error: {cause}", file=sys.stderr)
        raise SystemExit(4) from cause
    from pyshacl.cli import main as pyshacl_main

    try:
        pyshacl_main()
    except SystemExit as cause:
        if NETWORK_ATTEMPTED:
            raise SystemExit(3) from cause
        raise
    if NETWORK_ATTEMPTED:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
