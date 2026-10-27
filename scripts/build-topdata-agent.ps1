$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root "agent-topdata"
$out = Join-Path $agent "bin"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v3.5\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v3.5\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw ".NET Framework 3.5 csc.exe nao encontrado." }

$sources = @(
  "Program.cs",
  "ApiClient.cs",
  "TopdataDeviceClient.cs",
  "TopdataAfdParser.cs",
  "TopdataSdkReader.cs",
  "Models.cs"
) | ForEach-Object { Join-Path $agent $_ }

$exe = Join-Path $out "PontoCamara.TopdataAgent.exe"

& $csc /nologo /target:exe /out:$exe `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Configuration.dll `
  /reference:System.Web.Extensions.dll `
  $sources

if ($LASTEXITCODE -ne 0) { throw "Compilacao falhou com codigo $LASTEXITCODE" }

Copy-Item (Join-Path $agent "App.config") ($exe + ".config") -Force

Write-Host "Build concluido:" -ForegroundColor Green
Write-Host $exe -ForegroundColor Cyan
