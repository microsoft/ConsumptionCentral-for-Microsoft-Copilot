param([string]$Source, [string]$Python)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-CreditRefresh'
}, $true)
$script:FixtureRoot = $PSScriptRoot
# An extracted function has no defining script path; retain the fixture's script root.
Invoke-Expression $definition.Extent.Text.Replace('$PSScriptRoot', '$script:FixtureRoot')
$script:WorkDir = Join-Path $PSScriptRoot 'work'
$script:GraphToken = 'fixture-token'
$script:PythonCommand = @($Python)
$script:Uploaded = 0
function Test-Python {}
function Get-FolderSegments { 'Reports' }
function Get-DrivePath { param($Segments) 'fixture' }
function Invoke-Graph { param($Path) [pscustomobject]@{ Status = 404 } }
function Send-File {
  param($Path, $Name, $Segments)
  if ([System.IO.File]::ReadAllText($Path) -ne 'complete') { throw 'Incomplete file uploaded' }
  $script:Uploaded++
}
$failed = $false
try { Invoke-CreditRefresh } catch {
  if ($_.Exception.Message -notmatch 'fixture collection failure') { throw }
  $failed = $true
}
Write-Host "uploaded=$script:Uploaded; failed=$failed"
if ($failed -and $script:Uploaded -ne 0) { throw 'Uploaded after a failed collector' }
