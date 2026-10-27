$ErrorActionPreference = "Stop"

$repIp = $env:TOPDATA_HOST
if (-not $repIp) { $repIp = "10.20.20.222" }
$repPort = 51000
if ($env:TOPDATA_PORT) { $repPort = [int]$env:TOPDATA_PORT }

Write-Host "===== TOPDATA INNER REP - LEITURA SEGURA =====" -ForegroundColor Cyan
Write-Host ("REP: {0}:{1}" -f $repIp, $repPort)

Write-Host "[1/4] Testando rede..." -ForegroundColor Yellow
$tcp = Test-NetConnection $repIp -Port $repPort -WarningAction SilentlyContinue
if (-not $tcp.TcpTestSucceeded) { throw ("REP nao respondeu em {0}:{1}" -f $repIp, $repPort) }
Write-Host ("OK - TCP {0} acessivel" -f $repPort) -ForegroundColor Green

Write-Host "[2/4] Verificando .NET Framework 3.5..." -ForegroundColor Yellow
$net35 = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v3.5" -ErrorAction SilentlyContinue
if ($net35 -and $net35.Install -eq 1) {
  Write-Host "OK - .NET Framework 3.5 instalado" -ForegroundColor Green
} else {
  Write-Host "PENDENTE - .NET Framework 3.5 nao detectado" -ForegroundColor Yellow
}

Write-Host "[3/4] Procurando SDK Topdata..." -ForegroundColor Yellow
$roots = @(
  (Join-Path $PSScriptRoot "..\agent-topdata\sdk"),
  "C:\Program Files\Topdata",
  "C:\Program Files (x86)\Topdata"
) | Select-Object -Unique

$dlls = foreach ($root in $roots) {
  if (Test-Path $root) {
    Get-ChildItem $root -Recurse -File -Include *.dll -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "Inner|Rep|Topdata" }
  }
}

if ($dlls) {
  Write-Host "SDK/bibliotecas encontradas:" -ForegroundColor Green
  $dlls | Select-Object FullName, Length, @{N="Version";E={$_.VersionInfo.FileVersion}} | Format-Table -AutoSize
} else {
  Write-Host "PENDENTE - nenhuma DLL do SDK Inner REP encontrada." -ForegroundColor Yellow
  Write-Host "Coloque o pacote oficial em: agent-topdata\sdk"
}

Write-Host "[4/4] Regra de homologacao" -ForegroundColor Yellow
Write-Host "Modo: SOMENTE LEITURA"
Write-Host "Registro de prova esperado no REP:" -ForegroundColor Cyan
Write-Host "  Numero REP: 00009000540012804"
Write-Host "  Data/Hora:  27/10/2026 14:09"
Write-Host "  NSR:        000043106"
Write-Host ""
Write-Host "Nao executar envio de empregados, acerto de relogio, exclusao ou configuracao ate concluir a coleta." -ForegroundColor Red
