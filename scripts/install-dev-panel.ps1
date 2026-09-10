# Install the verified local development panel. Existing pairing/recovery data is untouched.
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource = Join-Path $taskRoot 'dist\panel'
$taskCep = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Adobe\CEP'))
$taskExtensions = Join-Path $taskCep 'extensions'
$taskTarget = [IO.Path]::GetFullPath((Join-Path $taskExtensions 'com.cookiemonster.ae'))
if ($taskTarget -ne (Join-Path $taskExtensions 'com.cookiemonster.ae') -or
    -not $taskTarget.StartsWith($taskCep + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Panel target escaped the per-user CEP directory'
}
foreach ($taskPath in @($taskCep, $taskExtensions, $taskTarget, $taskSource)) {
    if ((Test-Path -LiteralPath $taskPath) -and
        ((Get-Item -LiteralPath $taskPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing linked installation path: $taskPath"
    }
}
$taskDebug = Get-ItemProperty 'HKCU:\Software\Adobe\CSXS.12' -ErrorAction SilentlyContinue
if ($taskDebug.PlayerDebugMode -ne '1') {
    throw 'This unsigned development panel requires an already configured CEP development environment. No settings were changed.'
}
& node (Join-Path $taskRoot 'scripts\verify-build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Build verification failed; nothing installed' }
$taskBackupRoot = [IO.Path]::GetFullPath((Join-Path $taskCep ('cookiemonster-backups\' + [guid]::NewGuid().ToString())))
if (-not $taskBackupRoot.StartsWith($taskCep + '\cookiemonster-backups\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup path escaped its intended directory'
}
New-Item -ItemType Directory -Path $taskBackupRoot -Force | Out-Null
New-Item -ItemType Directory -Path $taskExtensions -Force | Out-Null
$taskStage = Join-Path $taskBackupRoot 'new-panel'
Copy-Item -LiteralPath $taskSource -Destination $taskStage -Recurse
if (Test-Path -LiteralPath $taskTarget) {
    Move-Item -LiteralPath $taskTarget -Destination (Join-Path $taskBackupRoot 'previous-panel')
}
Move-Item -LiteralPath $taskStage -Destination $taskTarget
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'dist\manifest.json') -Raw | ConvertFrom-Json
foreach ($taskArtifact in $taskManifest.artifacts) {
    if ($taskArtifact.path.StartsWith('panel/')) {
        $taskInstalled = Join-Path $taskTarget $taskArtifact.path.Substring(6)
        if ((Get-FileHash -LiteralPath $taskInstalled -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskArtifact.sha256) {
            throw "Installed hash mismatch: $taskInstalled. Previous panel retained at $taskBackupRoot"
        }
    }
}
Write-Output "Installed development panel $($taskManifest.version): $taskTarget"
Write-Output "Previous panel retained at: $taskBackupRoot"
Write-Output 'Restart After Effects before testing. No application was restarted and no preferences or profile data were changed.'
