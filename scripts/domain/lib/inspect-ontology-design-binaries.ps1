param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [string]$RepositoryRoot,
  [Parameter(Mandatory = $true)]
  [string]$TargetsPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$targets = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($target in (Get-Content -Raw -LiteralPath $TargetsPath | ConvertFrom-Json)) {
  [void]$targets.Add([string]$target)
}

function Convert-ToRepoPath {
  param([string]$Path)
  $repo = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($repo + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside repository root: $full"
  }
  return $full.Substring($repo.Length + 1).Replace('\', '/')
}

function Get-MagicHex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $buffer = New-Object byte[] 32
    $count = $stream.Read($buffer, 0, $buffer.Length)
    return [System.BitConverter]::ToString($buffer, 0, $count).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
}

function Inspect-XmlRdf {
  param([System.IO.FileInfo]$File)
  $defined = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $referenced = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $uniqueIris = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $elementCount = 0
  $ontologyCount = 0
  $classCount = 0
  $propertyCount = 0
  $settings = [System.Xml.XmlReaderSettings]::new()
  # FIBO RDF/XML uses internal DTD entity declarations. External resolution is disabled.
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Parse
  $settings.XmlResolver = $null
  $settings.MaxCharactersFromEntities = 16777216
  $settings.MaxCharactersInDocument = 536870912
  $reader = [System.Xml.XmlReader]::Create($File.FullName, $settings)
  try {
    while ($reader.Read()) {
      if ($reader.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
      $elementCount += 1
      if ($reader.NamespaceURI -eq 'http://www.w3.org/2002/07/owl#') {
        if ($reader.LocalName -eq 'Ontology') { $ontologyCount += 1 }
        elseif ($reader.LocalName -eq 'Class') { $classCount += 1 }
        elseif ($reader.LocalName -in @('ObjectProperty', 'DatatypeProperty', 'AnnotationProperty')) { $propertyCount += 1 }
      }
      if (-not $reader.HasAttributes) { continue }
      while ($reader.MoveToNextAttribute()) {
        if ($reader.NamespaceURI -ne 'http://www.w3.org/1999/02/22-rdf-syntax-ns#') { continue }
        if ($reader.LocalName -notin @('about', 'resource')) { continue }
        $iri = $reader.Value
        if ([System.Uri]::IsWellFormedUriString($iri, [System.UriKind]::Absolute)) {
          [void]$uniqueIris.Add($iri)
        }
        if (-not $targets.Contains($iri)) { continue }
        if ($reader.LocalName -eq 'about') { [void]$defined.Add($iri) }
        else { [void]$referenced.Add($iri) }
      }
      [void]$reader.MoveToElement()
    }
  } finally {
    $reader.Dispose()
  }
  return [ordered]@{
    path = Convert-ToRepoPath $File.FullName
    kind = 'xml'
    outcome = 'parsed'
    parser = 'System.Xml.XmlReader(DTD-internal-only,external-resolution-disabled)'
    magicHex = Get-MagicHex $File.FullName
    elementCount = $elementCount
    archiveEntryCount = $null
    archiveUncompressedBytes = $null
    uniqueIriCount = $uniqueIris.Count
    ontologyCount = $ontologyCount
    classCount = $classCount
    propertyCount = $propertyCount
    alignmentDefinitions = @($defined | Sort-Object)
    alignmentReferences = @($referenced | Sort-Object)
    sampleEntries = @()
    error = $null
  }
}

function Inspect-Zip {
  param([System.IO.FileInfo]$File)
  $stream = [System.IO.File]::OpenRead($File.FullName)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $false
    )
    try {
      $entryCount = 0
      [int64]$uncompressed = 0
      $samples = [System.Collections.Generic.List[string]]::new()
      foreach ($entry in $archive.Entries) {
        $entryCount += 1
        $uncompressed += $entry.Length
        if ($samples.Count -lt 12) { $samples.Add($entry.FullName) }
      }
      return [ordered]@{
        path = Convert-ToRepoPath $File.FullName
        kind = 'zip'
        outcome = 'metadata-inspected'
        parser = 'System.IO.Compression.ZipArchive'
        magicHex = Get-MagicHex $File.FullName
        elementCount = $null
        archiveEntryCount = $entryCount
        archiveUncompressedBytes = $uncompressed
        uniqueIriCount = $null
        ontologyCount = $null
        classCount = $null
        propertyCount = $null
        alignmentDefinitions = @()
        alignmentReferences = @()
        sampleEntries = @($samples)
        error = $null
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Inspect-OpaqueBinary {
  param([System.IO.FileInfo]$File)
  return [ordered]@{
    path = Convert-ToRepoPath $File.FullName
    kind = 'opaque-binary'
    outcome = 'metadata-inspected'
    parser = 'fixed-header-magic-inspection'
    magicHex = Get-MagicHex $File.FullName
    elementCount = $null
    archiveEntryCount = $null
    archiveUncompressedBytes = $null
    uniqueIriCount = $null
    ontologyCount = $null
    classCount = $null
    propertyCount = $null
    alignmentDefinitions = @()
    alignmentReferences = @()
    sampleEntries = @()
    error = $null
  }
}

$xmlExtensions = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@('.rdf', '.xml'),
  [System.StringComparer]::OrdinalIgnoreCase
)
$zipExtensions = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@('.zip', '.mdzip', '.docx', '.xlsx'),
  [System.StringComparer]::OrdinalIgnoreCase
)
$binaryExtensions = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@('.doc', '.jpg', '.jpeg', '.gif', '.png', '.pdf'),
  [System.StringComparer]::OrdinalIgnoreCase
)

Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' } |
  Sort-Object FullName |
  ForEach-Object {
    try {
      if ($xmlExtensions.Contains($_.Extension)) {
        $result = Inspect-XmlRdf $_
      } elseif ($zipExtensions.Contains($_.Extension)) {
        $result = Inspect-Zip $_
      } elseif ($binaryExtensions.Contains($_.Extension)) {
        $result = Inspect-OpaqueBinary $_
      } else {
        return
      }
    } catch {
      $failedMagic = ''
      try {
        $failedMagic = Get-MagicHex $_.FullName
      } catch {
        $failedMagic = ''
      }
      $result = [ordered]@{
        path = Convert-ToRepoPath $_.FullName
        kind = if ($xmlExtensions.Contains($_.Extension)) { 'xml' } elseif ($zipExtensions.Contains($_.Extension)) { 'zip' } else { 'opaque-binary' }
        outcome = 'failed'
        parser = if ($xmlExtensions.Contains($_.Extension)) { 'System.Xml.XmlReader(DTD-internal-only,external-resolution-disabled)' } elseif ($zipExtensions.Contains($_.Extension)) { 'System.IO.Compression.ZipArchive' } else { 'fixed-header-magic-inspection' }
        magicHex = $failedMagic
        elementCount = $null
        archiveEntryCount = $null
        archiveUncompressedBytes = $null
        uniqueIriCount = $null
        ontologyCount = $null
        classCount = $null
        propertyCount = $null
        alignmentDefinitions = @()
        alignmentReferences = @()
        sampleEntries = @()
        error = $_.Exception.Message
      }
    }
    $result | ConvertTo-Json -Depth 5 -Compress
  }
