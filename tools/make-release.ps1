# Builds a release the Update button can install: the Setup plus a signed dist\latest.json.
#   tools\make-release.ps1 [-Notes "what changed"] [-Publish]
# The version comes from shell\Cargo.toml: raise it there first. -Publish creates the GitHub release
# (needs the GitHub CLI signed in); without it the two files are left in dist\ to upload by hand.
# The signing key is %USERPROFILE%\.rove\update-signing-key.pem (see tools\sign-release.mjs).
param([string]$Notes = '', [switch]$Publish)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = (Select-String -Path (Join-Path $root 'shell\src\update.rs') -Pattern 'pub const REPO: &str = "([^"]+)"').Matches[0].Groups[1].Value
$version = (Select-String -Path (Join-Path $root 'shell\Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value

& (Join-Path $PSScriptRoot 'make-installer.ps1') | Out-Host

$dist = Join-Path $root 'dist'
$setup = Join-Path $dist "ROVE-Setup-$version.exe"
$url = "https://github.com/$repo/releases/download/v$version/ROVE-Setup-$version.exe"
$notesFile = Join-Path $dist 'release-notes.txt'
[IO.File]::WriteAllText($notesFile, $Notes)
node (Join-Path $PSScriptRoot 'sign-release.mjs') $version $setup $url $notesFile
if ($LASTEXITCODE) { throw 'signing failed' }

if ($Publish) {
    gh release create "v$version" $setup (Join-Path $dist 'latest.json') --repo $repo --title "ROVE $version" --notes-file $notesFile
    if ($LASTEXITCODE) { throw 'publishing failed' }
    "published: https://github.com/$repo/releases/tag/v$version"
} else {
    "ready to upload as release v${version}: $setup and $(Join-Path $dist 'latest.json')"
}
