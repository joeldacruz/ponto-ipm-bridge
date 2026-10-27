$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot "..\agent-topdata\sdk"
if (-not (Test-Path $root)) { throw "Pasta SDK nao encontrada: $root" }

Write-Host "Removendo bloqueio de arquivos baixados da Internet..." -ForegroundColor Cyan
Get-ChildItem $root -Recurse -File | ForEach-Object {
  try { Unblock-File -LiteralPath $_.FullName -ErrorAction Stop } catch { }
}

$dll = Get-ChildItem $root -Recurse -File -Filter "SDK_Inner_Rep.dll" | Select-Object -First 1
if (-not $dll) { throw "SDK_Inner_Rep.dll nao encontrada." }

Write-Host ("DLL principal: " + $dll.FullName) -ForegroundColor Green
Write-Host "Arquivos desbloqueados. Nenhum comando foi enviado ao REP." -ForegroundColor Green
