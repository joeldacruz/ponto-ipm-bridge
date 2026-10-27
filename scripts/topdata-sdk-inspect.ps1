$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot "..\agent-topdata\sdk"
$outDir = Join-Path $PSScriptRoot "..\data\topdata"
$outFile = Join-Path $outDir "sdk-inspect.txt"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not (Test-Path $root)) { throw "Pasta SDK nao encontrada: $root" }

$dll = Get-ChildItem $root -Recurse -File -Filter "SDK_Inner_Rep.dll" | Select-Object -First 1
if (-not $dll) { throw "SDK_Inner_Rep.dll nao encontrada." }

"===== SDK TOPDATA - INSPECAO SOMENTE LEITURA =====" | Set-Content $outFile -Encoding UTF8
("DLL: " + $dll.FullName) | Add-Content $outFile
("FileVersion: " + $dll.VersionInfo.FileVersion) | Add-Content $outFile
("ProductVersion: " + $dll.VersionInfo.ProductVersion) | Add-Content $outFile
"" | Add-Content $outFile

"===== TIPOS E METODOS PUBLICOS =====" | Add-Content $outFile
try {
  $asm = [Reflection.Assembly]::LoadFrom($dll.FullName)
  foreach ($type in ($asm.GetExportedTypes() | Sort-Object FullName)) {
    ("TYPE " + $type.FullName) | Add-Content $outFile
    foreach ($m in ($type.GetMethods([Reflection.BindingFlags]"Public,Instance,Static,DeclaredOnly") | Sort-Object Name)) {
      $pars = @($m.GetParameters() | ForEach-Object { $_.ParameterType.Name + " " + $_.Name }) -join ", "
      ("  METHOD {0} {1}({2})" -f $m.ReturnType.Name, $m.Name, $pars) | Add-Content $outFile
    }
  }
} catch {
  ("REFLECTION_ERROR: " + $_.Exception.Message) | Add-Content $outFile
}

"" | Add-Content $outFile
"===== REFERENCIAS NO EXEMPLO C# =====" | Add-Content $outFile
$patterns = "Versao","Versão","Firmware","Conecta","Conectar","Porta","51000","AFD","NSR","Marcacao","Marcação","Registro","Ler","Colet"
$cs = Get-ChildItem $root -Recurse -File -Filter "*.cs" -ErrorAction SilentlyContinue
foreach ($p in $patterns) {
  ("--- PADRAO: " + $p + " ---") | Add-Content $outFile
  $hits = $cs | Select-String -Pattern $p -SimpleMatch -ErrorAction SilentlyContinue
  foreach ($h in ($hits | Select-Object -First 120)) {
    ("{0}:{1}: {2}" -f $h.Path, $h.LineNumber, $h.Line.Trim()) | Add-Content $outFile
  }
}

Write-Host "Relatorio criado em:" -ForegroundColor Green
Write-Host $outFile -ForegroundColor Cyan
Write-Host ""
Write-Host "Primeiras linhas relevantes:" -ForegroundColor Yellow
Get-Content $outFile | Select-String -Pattern "TYPE |METHOD |Versao|Versão|Firmware|AFD|NSR|51000|Conect" | Select-Object -First 100

Write-Host ""
Write-Host "Nenhum metodo do SDK foi executado; apenas inspecao de DLL e codigo-fonte." -ForegroundColor Green
