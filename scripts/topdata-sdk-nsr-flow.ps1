$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot "..\agent-topdata\sdk"
$src = Get-ChildItem $root -Recurse -File -Filter "frmExemploSDK.cs" | Select-Object -First 1
if (-not $src) { throw "frmExemploSDK.cs nao encontrado." }

$lines = Get-Content $src.FullName
$from = 688
$to = [Math]::Min(780, $lines.Count)

Write-Host "===== TOPDATA - ROTINA OFICIAL ColetaNSR =====" -ForegroundColor Cyan
Write-Host ("Fonte: " + $src.FullName)
Write-Host ""
for ($i=$from; $i -le $to; $i++) {
  "{0,5}: {1}" -f $i, $lines[$i-1]
}

Write-Host ""
Write-Host "===== METODOS DA DLL RELACIONADOS A LEITURA =====" -ForegroundColor Cyan
$dll = Get-ChildItem $root -Recurse -File -Filter "SDK_Inner_Rep.dll" | Select-Object -First 1
if ($dll) {
  try {
    $asm = [Reflection.Assembly]::LoadFrom($dll.FullName)
    $type = $asm.GetType("Sdk_Inner_Rep.InnerRepSdk", $false)
    if ($type) {
      $type.GetMethods() |
        Where-Object { $_.Name -match "Registro|Leitura|Serial|NSR|Nsr|Relogio|Versao|Versão" } |
        Sort-Object Name -Unique |
        ForEach-Object {
          $pars = @($_.GetParameters() | ForEach-Object { $_.ParameterType.Name + " " + $_.Name }) -join ", "
          "{0} {1}({2})" -f $_.ReturnType.Name, $_.Name, $pars
        }
    } else {
      Write-Host "Tipo Sdk_Inner_Rep.InnerRepSdk nao localizado por reflection." -ForegroundColor Yellow
    }
  } catch {
    Write-Host ("Reflection falhou: " + $_.Exception.Message) -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Nenhum comando foi enviado ao REP." -ForegroundColor Green
