"""
One Slither analysis

Reads a request from stdin and writes the result to stdout, both JSON. The
server runs this in a child process so a compile or analysis that hangs can
be killed, and nothing from one contract is left in memory for the next.

Request:  {"compiler": "0.8.24", "sources": {path: content},
           "settings": {optimizer, evmVersion, viaIR, remappings, libraries}}
Result:   {"solc", "slither", "detectors", "seconds", "findings": [...]}
          or {"error": "...", "detail": "..."}

The contract is compiled with the solc version it was verified with,
installed by solc-select on first use. Nothing in it is executed: solc
compiles it and Slither reads the compiler's output.
"""
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import time

VERSION = re.compile(r"^\d+\.\d+\.\d+$")
SETTINGS_KEPT = ("optimizer", "evmVersion", "viaIR", "remappings", "libraries")
MAX_DESCRIPTION = 800
MAX_LOCATIONS = 5
# The result is the only thing on stdout: anything the compiler or Slither
# prints goes to stderr instead.
OUT = sys.stdout
sys.stdout = sys.stderr


def fail(error, detail=""):
    print(json.dumps({"error": error, "detail": str(detail)[:2000]}), file=OUT)
    sys.exit(0)


def safe_path(path):
    """The source's own name, if it can be written inside the work directory."""
    p = str(path).replace("\\", "/")
    if not p or len(p) > 400 or "\0" in p or p.startswith("/") or re.match(r"^[A-Za-z]:", p):
        return None
    if any(part in ("..", "") for part in p.split("/")):
        return None
    return p


def ensure_solc(version):
    """solc-select installs each version once per instance; the binary is checked against its published hash."""
    installed = subprocess.run(["solc-select", "versions"], capture_output=True, text=True, timeout=30).stdout
    if not re.search(rf"^{re.escape(version)}\b", installed, re.M):
        r = subprocess.run(["solc-select", "install", version], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            fail("solc_unavailable", f"solc {version} couldn't be installed: {r.stderr or r.stdout}")


def location(element, work):
    sm = element.get("source_mapping") or {}
    absolute = sm.get("filename_absolute") or ""
    lines = sm.get("lines") or []
    return {
        "file": os.path.relpath(absolute, work) if absolute else None,
        "lines": [lines[0], lines[-1]] if lines else [],
        "name": element.get("name"),
        "type": element.get("type"),
    }


def main():
    try:
        req = json.load(sys.stdin)
    except ValueError as err:
        fail("bad_request", err)
    version = str(req.get("compiler") or "")
    if not VERSION.match(version):
        fail("bad_request", "compiler must be a released solc version, such as 0.8.24")
    sources = req.get("sources") or {}
    if not isinstance(sources, dict) or not sources:
        fail("bad_request", "sources must be {path: content}")

    work = tempfile.mkdtemp(prefix="slither-")
    for path, content in sources.items():
        p = safe_path(path)
        if p is None:
            fail("unsupported_path", f"{path!r} can't be analysed: Slither needs each source at a relative path")
        full = os.path.join(work, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(str(content))

    settings = {k: v for k, v in (req.get("settings") or {}).items() if k in SETTINGS_KEPT and v is not None}
    standard_json = {
        "language": "Solidity",
        "sources": {p: {"content": str(c)} for p, c in sources.items()},
        "settings": settings,
    }

    ensure_solc(version)
    os.environ["SOLC_VERSION"] = version
    os.chdir(work)

    # Imported here so a bad request is answered without loading Slither.
    from crytic_compile import CryticCompile
    from crytic_compile.platform.exceptions import InvalidCompilation
    from crytic_compile.platform.solc_standard_json import SolcStandardJson
    from slither import Slither
    from slither.detectors import all_detectors
    from slither.detectors.abstract_detector import AbstractDetector
    import slither as slither_pkg

    started = time.time()
    try:
        compiled = CryticCompile(SolcStandardJson(standard_json), solc_working_dir=work)
    except InvalidCompilation as err:
        fail("compile_failed", err)
    analysis = Slither(compiled)
    detectors = [d for _, d in inspect.getmembers(all_detectors)
                 if inspect.isclass(d) and issubclass(d, AbstractDetector)]
    for d in detectors:
        analysis.register_detector(d)

    findings = []
    for results in analysis.run_detectors():
        for r in results:
            findings.append({
                "check": r.get("check"),
                "impact": r.get("impact"),
                "confidence": r.get("confidence"),
                "description": (r.get("description") or "").strip()[:MAX_DESCRIPTION],
                "locations": [location(e, work) for e in (r.get("elements") or [])[:MAX_LOCATIONS]],
            })

    print(json.dumps({
        "solc": version,
        "slither": getattr(slither_pkg, "__version__", None) or _installed_version(),
        "detectors": len(detectors),
        "seconds": round(time.time() - started, 1),
        "findings": findings,
    }), file=OUT)


def _installed_version():
    try:
        from importlib.metadata import version
        return version("slither-analyzer")
    except Exception:  # noqa: BLE001 — the version is informational
        return None


if __name__ == "__main__":
    main()
