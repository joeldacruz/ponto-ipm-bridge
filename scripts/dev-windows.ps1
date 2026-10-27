$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

$env:PORT = "3090"
$env:DB_PATH = ".\data\ponto.db"
$env:TOPDATA_HOST = "10.20.20.222"
$env:TOPDATA_PORT = "51000"
$env:TOPDATA_AGENT_ID = "topdata-windows-01"

Write-Host "===== PONTO CAMARA - DESENVOLVIMENTO =====" -ForegroundColor Cyan
Write-Host "Painel: http://127.0.0.1:3090"
Write-Host "REP 02: 10.20.20.222:51000"
Write-Host ""

npm start
