# Stops Hermes Agency Hub and its client containers. Never deletes data.

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker is not installed, so there is nothing to stop."
  exit 0
}
docker ps *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker is not running, so there is nothing to stop."
  exit 0
}

# Tenants are created by the hub, so compose does not know about them.
docker ps --filter "name=hermes-client-" --format "{{.Names}}" | ForEach-Object {
  Write-Host "Stopping $_"
  docker stop $_ | Out-Null
}

docker compose stop
if ($LASTEXITCODE -ne 0) {
  Write-Host "Could not stop everything. See the messages above." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Stopped. Your clients and data are kept. Run start.bat to start again." -ForegroundColor Green
