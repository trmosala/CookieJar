param([Parameter(Mandatory=$true)][string]$Config, [switch]$Apply)
$ErrorActionPreference = 'Stop'
$taskNode = Get-Command node -ErrorAction Stop
$taskArguments = @((Join-Path $PSScriptRoot 'install.mjs'), '--config', $Config)
if ($Apply) { $taskArguments += '--apply' }
& $taskNode.Source @taskArguments
exit $LASTEXITCODE
