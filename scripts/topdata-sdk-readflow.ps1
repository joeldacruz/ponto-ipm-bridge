$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot "..\agent-topdata\sdk"
$src = Get-ChildItem $root -Recurse -File -Filter "frmExemploSDK.cs" | Select-Object -First 1
if (-not $src) { throw "frmExemploSDK.cs nao encontrado." }

$outDir = Join-Path $PSScriptRoot "..\data\topdata"
$outFile = Join-Path $outDir "sdk-readflow.txt"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$lines = Get-Content $src.FullName

function Add-Range([int]$from, [int]$to, [string]$title) {
  "===== $title =====" | Add-Content $outFile
  if ($from -lt 1) { $from = 1 }
  if ($to -gt $lines.Count) { $to = $lines.Count }
  for ($i=$from; $i -le $to; $i++) {
    ("{0,5}: {1}" -f $i, $lines[$i-1]) | Add-Content $outFile
  }
  "" | Add-Content $outFile
}

Set-Content $outFile ("ARQUIVO: " + $src.FullName) -Encoding UTF8
"" | Add-Content $outFile

# Cabecalho/declaracoes/instanciacao
Add-Range 1 140 "CABECALHO E DECLARACOES"

# Busca pontos importantes e captura contexto
$patterns = @(
  "new InnerRep",
  "innerRep =",
  "ParametrosComunicacao",
  "SolicitaRegistroDoNsr",
  "ColetaNSR",
  "Ultimo",
  "NSR",
  "Conecta",
  "Desconecta",
  "Recebe",
  "Retorno",
  "AFD"
)

$seen = @{}
foreach ($p in $patterns) {
  $hits = Select-String -Path $src.FullName -Pattern $p -SimpleMatch -ErrorAction SilentlyContinue
  foreach ($h in $hits) {
    $from = [Math]::Max(1, $h.LineNumber - 18)
    $to = [Math]::Min($lines.Count, $h.LineNumber + 35)
    $key = "$from-$to"
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      Add-Range $from $to ("CONTEXTO: " + $p + " / linha " + $h.LineNumber)
    }
  }
}

Write-Host "Fluxo de leitura extraido para:" -ForegroundColor Green
Write-Host $outFile -ForegroundColor Cyan
Write-Host ""
Write-Host "Trechos mais relevantes:" -ForegroundColor Yellow
Get-Content $outFile | Select-String -Pattern "InnerRep|ParametrosComunicacao|SolicitaRegistroDoNsr|ColetaNSR|Conecta|Desconecta|Recebe|Retorno|AFD" -Context 3,6 | Select-Object -First 220

Write-Host ""
Write-Host "Este script apenas le o codigo-fonte do exemplo oficial; nao conecta ao REP." -ForegroundColor Green
