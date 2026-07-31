# Setup SHACL Trial runtime (Windows)
# Installs Python 3.12 via winget if missing, then pinned pyshacl from requirements-shacl.txt.
# Usage (from repo root): powershell -ExecutionPolicy Bypass -File scripts/domain/setup-shacl-runtime.ps1

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

$Py = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
if (-not (Test-Path $Py)) {
  Write-Host "Installing Python 3.12 via winget..."
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --disable-interactivity
  if (-not (Test-Path $Py)) {
    throw "Python 3.12 not found at $Py after winget install"
  }
}

& $Py --version
& $Py -m pip install -r "docs\domain\infrastructure\requirements-shacl.txt"
& $Py -c "import pyshacl; print('pyshacl', pyshacl.__version__)"
node "scripts\domain\run-pyshacl-smoke.cjs"
Write-Host "Done. Re-run: node scripts/domain/test-all-domain.js"
