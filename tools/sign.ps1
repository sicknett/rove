# Signs files with Azure Artifact Signing (Microsoft's code signing service).
#   tools\sign.ps1 file1.exe [file2.exe ...]
#
# Needs, on this PC:
#   - signtool.exe (Windows SDK)
#   - the signing client library:  winget install -e --id Microsoft.Azure.TrustedSigningClientTools
#   - a sign-in that may use the certificate profile:  az login   (Azure CLI)
#   - tools\signing.local  (never committed), JSON with the account's own values:
#       { "Endpoint": "https://eus.codesigning.azure.net/",
#         "CodeSigningAccountName": "<account>",
#         "CertificateProfileName": "<profile>" }
# Exits with an error if any file could not be signed and verified.
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$ErrorActionPreference = 'Stop'

$config = Join-Path $PSScriptRoot 'signing.local'
if (-not (Test-Path $config)) { throw "No signing settings: $config is missing (see the top of tools\sign.ps1)." }
$settings = Get-Content $config -Raw | ConvertFrom-Json
foreach ($k in 'Endpoint', 'CodeSigningAccountName', 'CertificateProfileName') {
    if (-not $settings.$k) { throw "tools\signing.local has no $k." }
}

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe (Windows SDK) was not found.' }

$dlib = @(
    "$env:LOCALAPPDATA\Microsoft\MicrosoftTrustedSigningClientTools",
    "$env:ProgramFiles\Microsoft Trusted Signing Client Tools",
    "${env:ProgramFiles(x86)}\Microsoft Trusted Signing Client Tools",
    "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools"
) | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue } |
    Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if (-not $dlib) { throw 'The signing client library was not found (winget install -e --id Microsoft.Azure.TrustedSigningClientTools).' }

# The library reads the account from a metadata file; the sign-in comes from the Azure CLI.
$metadata = Join-Path $env:TEMP "rove-signing-$PID.json"
@{
    Endpoint               = $settings.Endpoint
    CodeSigningAccountName = $settings.CodeSigningAccountName
    CertificateProfileName = $settings.CertificateProfileName
    ExcludeCredentials     = @('ManagedIdentityCredential', 'EnvironmentCredential', 'WorkloadIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
} | ConvertTo-Json | Set-Content $metadata -Encoding ascii

try {
    foreach ($file in $Files) {
        $path = (Resolve-Path $file).Path
        & $signtool.FullName sign /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib.FullName /dmdf $metadata $path | Out-Host
        if ($LASTEXITCODE) { throw "signing failed for $path" }
        $sig = Get-AuthenticodeSignature $path
        if ($sig.Status -ne 'Valid') { throw "the signature on $path does not verify ($($sig.Status))" }
        "signed: $path  ($($sig.SignerCertificate.Subject))"
    }
} finally {
    Remove-Item $metadata -ErrorAction SilentlyContinue
}
