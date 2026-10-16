[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Inspect','Prepare','Install','Snapshot','Upgrade','Verify','Uninstall')][string]$Action,
    [string]$TestRoot,
    [string]$Installer,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
    [switch]$Interactive,
    [switch]$ConfirmTestUninstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$product = '写一本书'
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$settings = Join-Path $env:APPDATA 'net.writeabook.desktop\settings.sqlite3'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk"

function Assert-NoReparse([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point is not allowed in test paths: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Get-AppRegistrations {
    foreach ($base in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        foreach ($key in Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue) {
            $entry = Get-ItemProperty -LiteralPath $key.PSPath
            $name = $entry.PSObject.Properties['DisplayName']
            $location = $entry.PSObject.Properties['InstallLocation']
            if (($name -and $name.Value -eq $product) -or $key.PSChildName -eq 'net.writeabook.desktop' -or ($location -and $location.Value -match 'Write.a.Book|写一本书')) { $entry }
        }
    }
}
function Assert-AppClosed {
    if (Get-Process -Name 'write-a-book' -ErrorAction SilentlyContinue) {
        throw 'Close all Write-a-Book windows normally before this action. No processes are stopped by this script.'
    }
}
function Assert-TestRegistration {
    $entries = @(Get-AppRegistrations)
    if ($entries.Count -ne 1 -or -not (Test-Path -LiteralPath $uninstallKey)) { throw 'Expected exactly the current-user test installation.' }
    $entry = Get-ItemProperty -LiteralPath $uninstallKey
    if ($entry.InstallLocation.Trim('"').TrimEnd('\') -ne $installDir -or $entry.Publisher -ne 'Write-a-Book') { throw 'Installed application does not belong to this test. Refusing mutation.' }
    if ($entry.UninstallString.Trim('"') -ne (Join-Path $installDir 'uninstall.exe')) { throw 'Unexpected uninstaller path.' }
    return $entry
}
function Get-PreservedFiles {
    if (-not (Test-Path -LiteralPath (Join-Path $libraryDir 'library.sqlite3') -PathType Leaf)) { throw 'Create and save real sample text in the installed app first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $libraryDir 'attachments') -PathType Container)) { throw 'Missing library attachments directory.' }
    $files = [ordered]@{}
    foreach ($item in Get-ChildItem -LiteralPath $libraryDir -Recurse -Force) {
        Assert-NoReparse $item.FullName
        if (-not $item.PSIsContainer) { $files['library/' + $item.FullName.Substring($libraryDir.Length + 1)] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    }
    if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { throw 'Missing remembered-library settings.' }
    Assert-NoReparse $settings
    $files['settings.sqlite3'] = (Get-FileHash -LiteralPath $settings -Algorithm SHA256).Hash
    return $files
}
function Invoke-TestInstaller {
    if (-not $Installer -or -not [IO.Path]::IsPathFullyQualified($Installer)) { throw 'Pass an absolute installer path.' }
    $artifact = [IO.Path]::GetFullPath($Installer)
    $bundleRoot = [IO.Path]::GetFullPath((Join-Path $repo 'src-tauri\target\release\bundle\nsis')) + '\'
    if (-not $artifact.StartsWith($bundleRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $artifact.EndsWith('-setup.exe') -or -not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw 'Only this checkout NSIS build output may be installed.' }
    Assert-NoReparse $artifact
    if (-not $ExpectedVersion) { throw 'ExpectedVersion is required.' }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($artifact).ProductVersion -ne $ExpectedVersion) { throw 'Installer version differs from ExpectedVersion.' }
    $mode = if ($Interactive) { '' } else { '/S' }
    $update = if ($Action -eq 'Upgrade') { '/UPDATE' } else { '' }
    $arguments = "$mode $update /D=$installDir".Trim()
    $windowStyle = if ($Interactive) { 'Normal' } else { 'Hidden' }
    $process = Start-Process -FilePath $artifact -ArgumentList $arguments -WindowStyle $windowStyle -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed or was cancelled: $($process.ExitCode)" }
    $entry = Assert-TestRegistration
    if ($entry.DisplayVersion -ne $ExpectedVersion -or -not (Test-Path -LiteralPath (Join-Path $installDir 'write-a-book.exe'))) { throw 'Installed version or main executable is missing.' }
    $binary = Join-Path $installDir 'write-a-book.exe'
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($binary).ProductVersion -ne $ExpectedVersion) { throw 'Installed executable version differs from ExpectedVersion.' }
    $shell = New-Object -ComObject WScript.Shell
    if (-not (Test-Path -LiteralPath $startMenu) -or $shell.CreateShortcut($startMenu).TargetPath -ne (Join-Path $installDir 'write-a-book.exe')) { throw 'Start-menu shortcut is missing or points elsewhere.' }
    [pscustomobject]@{Version=$entry.DisplayVersion; ExecutableSHA256=(Get-FileHash -LiteralPath $binary).Hash; InstallerSHA256=(Get-FileHash -LiteralPath $artifact).Hash; StartMenu=$startMenu; DesktopExists=(Test-Path -LiteralPath $desktop)}
}

if ($Action -eq 'Inspect') {
    Get-AppRegistrations | Select-Object PSPath,DisplayName,DisplayVersion,InstallLocation,UninstallString
    foreach ($path in @((Join-Path $env:LOCALAPPDATA $product), $startMenu, $desktop, (Join-Path $env:PUBLIC "Desktop\$product.lnk"))) { [pscustomobject]@{Path=$path; Exists=(Test-Path -LiteralPath $path)} }
    return
}
if (-not $TestRoot -or -not [IO.Path]::IsPathFullyQualified($TestRoot)) { throw 'TestRoot must be an absolute path.' }
$root = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
$scratch = [IO.Path]::GetFullPath((Join-Path $repo '.scratch')).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($root) -ne $scratch -or [IO.Path]::GetFileName($root) -notmatch '^t53-install-[0-9a-f]{32}$') { throw 'TestRoot must be this checkout .scratch/t53-install-<32 lowercase hex>.' }
Assert-NoReparse $root
$installDir = Join-Path $root 'app'
$libraryDir = Join-Path $root 'library'
$manifestPath = Join-Path $root 'test-scope.json'
$snapshotPath = Join-Path $root 'preserved-files.json'
Assert-AppClosed
if ($Action -eq 'Prepare') {
    if (Test-Path -LiteralPath $root) { throw 'TestRoot must not exist before Prepare.' }
    if (@(Get-AppRegistrations).Count -or (Test-Path -LiteralPath $startMenu) -or (Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA $product)) -or (Test-Path -LiteralPath (Join-Path $env:PUBLIC "Desktop\$product.lnk"))) { throw 'Existing application installation or shortcut found. Do not overwrite it.' }
    New-Item -ItemType Directory -Path $root,$libraryDir | Out-Null
    [ordered]@{schema=1;root=$root;repo=$repo;install=$installDir;library=$libraryDir;settings=$settings;createdUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
    if (Test-Path -LiteralPath $settings) { Copy-Item -LiteralPath $settings -Destination (Join-Path $root 'settings-before-test.sqlite3') }
    Write-Output "Prepared $root. Existing settings copied for restoration by the test coordinator; the script never overwrites them."
    return
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Prepare this test scope first.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.root -ne $root -or $manifest.repo -ne $repo -or $manifest.install -ne $installDir -or $manifest.library -ne $libraryDir -or $manifest.settings -ne $settings) { throw 'Test scope does not match this checkout and user.' }
switch ($Action) {
    'Install' {
        if (@(Get-AppRegistrations).Count -or (Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $startMenu) -or (Test-Path -LiteralPath $desktop)) { throw 'Expected a fresh test installation.' }
        Invoke-TestInstaller
    }
    'Snapshot' {
        $null = Assert-TestRegistration
        Get-PreservedFiles | ConvertTo-Json | Set-Content -LiteralPath $snapshotPath -Encoding utf8
        Write-Output 'Recorded byte hashes of the saved library, attachments and remembered-library settings. GUI evidence must be recorded separately.'
    }
    'Upgrade' {
        $entry = Assert-TestRegistration
        if (-not $ExpectedVersion -or [version]$ExpectedVersion -le [version]$entry.DisplayVersion) { throw 'Upgrade requires a strictly newer version.' }
        if (-not (Test-Path -LiteralPath $snapshotPath)) { throw 'Snapshot saved GUI content before upgrade.' }
        Invoke-TestInstaller
    }
    'Verify' {
        if (-not (Test-Path -LiteralPath $snapshotPath)) { throw 'Snapshot is required.' }
        $before = Get-Content -LiteralPath $snapshotPath -Raw | ConvertFrom-Json -AsHashtable
        $after = Get-PreservedFiles
        if ($before.Count -ne $after.Count) { throw 'Preserved-file inventory changed.' }
        foreach ($name in $before.Keys) { if (-not $after.Contains($name) -or $before[$name] -ne $after[$name]) { throw "Preserved file changed or missing: $name" } }
        Write-Output "All $($before.Count) saved files are byte-identical; attachments directory exists. This does not substitute for reopening the GUI."
    }
    'Uninstall' {
        if (-not $ConfirmTestUninstall) { throw 'ConfirmTestUninstall is required for the explicitly prepared test installation.' }
        $null = Assert-TestRegistration
        if (-not (Test-Path -LiteralPath $snapshotPath)) { throw 'Snapshot saved content before uninstall.' }
        $uninstaller = Join-Path $installDir 'uninstall.exe'
        Assert-NoReparse $uninstaller
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
        if ((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $startMenu) -or (Test-Path -LiteralPath $desktop)) { throw 'Uninstall left an application registration, installation directory or shortcut.' }
        Write-Output 'Test application removed. Run Verify, then reinstall and reopen the same library to observe preservation.'
    }
}
