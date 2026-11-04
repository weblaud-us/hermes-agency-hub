# Starts Hermes Agency Hub and prints its logins. Safe to run repeatedly.
#
# Everything runs in Docker, so this is a thin shortcut around
# `docker compose up -d --build`. The demo client lives here and not in compose,
# so a plain `up` on a server never creates dummy clients or saves passwords.

param([switch]$NoBrowser)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$EnvFile = Join-Path $Root ".env"
$Hub = "http://localhost:8080"
$Web = "http://localhost:3000"
$Out = "$env:TEMP\hermes-test"
$DemoFile = "$Out\demo.json"
$LinkFile = "$Out\demo-link.json"
$LoginsFile = "$Out\demo-logins.txt"

function Say($Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Warn($Text) { Write-Host "WARNING: $Text" -ForegroundColor Yellow }
function Fail($Text) {
  Write-Host ""
  Write-Host "FAILED: $Text" -ForegroundColor Red
  exit 1
}

function Get-EnvValue($Name) {
  foreach ($Line in Get-Content $EnvFile) {
    if ($Line -match "^\s*$Name=(.*)$") { return $Matches[1].Trim() }
  }
  return ""
}

function Test-DockerReady {
  docker ps *> $null
  return $LASTEXITCODE -eq 0
}

function Wait-ForUrl($Url, $Name) {
  curl.exe -s -o NUL -m 120 --retry 40 --retry-all-errors --retry-delay 3 $Url
  if ($LASTEXITCODE -ne 0) { Fail "$Name did not answer at $Url. Run: docker compose logs --tail 50" }
}

function Get-ApiError($Err) {
  if ($Err.ErrorDetails -and $Err.ErrorDetails.Message) { return $Err.ErrorDetails.Message }
  return $Err.Exception.Message
}

# ------------------------------------------------------------------ settings
# Compose refuses to start without these, so this has to come first. An empty
# file counts as missing. A file with content is never overwritten.
if (-not (Test-Path $EnvFile) -or [string]::IsNullOrWhiteSpace((Get-Content $EnvFile -Raw))) {
  Say "Writing local test settings to .env"
  @'
ADMIN_API_KEY=local-test-admin-key-12345
POSTGRES_USER=hermes
POSTGRES_PASSWORD=local-test-postgres-password
POSTGRES_DB=hermes_hub
ENVIRONMENT=local
DEBUG=true
LOG_LEVEL=INFO
BASE_DOMAIN=localhost
HUB_PUBLIC_URL=http://localhost:8080
PORTAL_PUBLIC_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
HUB_BIND=127.0.0.1
NGINX_HTTP_PORT=80
DOCKER_GID=0
DATA_ROOT=/srv/hermes-multi
CLIENT_IMAGE=nousresearch/hermes-agent:latest
CLIENT_IMAGE_PULL_POLICY=missing
NGINX_CONTROL_MODE=docker
NGINX_UPSTREAM_MODE=network
PROBE_MODE=network
'@ | Set-Content -Encoding ascii $EnvFile
}

$AdminKey = Get-EnvValue "ADMIN_API_KEY"
if (-not $AdminKey) { Fail "ADMIN_API_KEY is empty in .env. Set it, or empty the file to get the local test settings." }

# -------------------------------------------------------------------- docker
$DockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and -not (Test-Path $DockerDesktop)) {
  Start-Process "https://www.docker.com/products/docker-desktop/"
  Fail "Docker Desktop is not installed. Install it from the page that just opened, start it, then run this again."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue) -or -not (Test-DockerReady)) {
  if (Test-Path $DockerDesktop) {
    Say "Starting Docker Desktop. This can take a couple of minutes."
    Start-Process $DockerDesktop
  }
  $Deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Seconds 3
    $Ready = (Get-Command docker -ErrorAction SilentlyContinue) -and (Test-DockerReady)
  } until ($Ready -or (Get-Date) -gt $Deadline)
  if (-not $Ready) { Fail "Docker is not ready. Start Docker Desktop, wait until it says it is running, then run this again." }
}

# --------------------------------------------------------------------- stack
Say "Starting everything. The first run downloads about 4.3 GB and builds two images."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose could not start. See the messages above, and Troubleshooting in LOCAL_TESTING.md." }

# Tenants are created by the hub, so compose does not start them again.
docker ps -a --filter "name=hermes-client-" --filter "status=exited" --format "{{.Names}}" | ForEach-Object {
  Say "Starting $_"
  docker start $_ | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn "Could not start $_." }
}

Say "Waiting for the hub and the website"
Wait-ForUrl "$Hub/healthz" "The hub"
Wait-ForUrl $Web "The website"

# --------------------------------------------------------------- demo client
$Admin = @{ "X-API-Key" = $AdminKey }
$Json = "application/json"
New-Item -ItemType Directory -Force $Out | Out-Null

try {
  $Existing = (Invoke-RestMethod "$Hub/api/v1/clients?limit=200" -Headers $Admin -ErrorAction Stop).items | Where-Object { $_.slug -eq "demo" }
} catch {
  Fail "The hub refused the admin key from .env: $(Get-ApiError $_)"
}

$HaveLogins = $false
if ($Existing -and (Test-Path $DemoFile) -and (Test-Path $LoginsFile)) {
  # A saved file from an earlier demo client holds a password that no longer works.
  $HaveLogins = (Get-Content $DemoFile -Raw | ConvertFrom-Json).client_id -eq $Existing.id
}

if (-not $Existing) {
  Say "Creating the demo client. This takes about 20 seconds."
  try {
    $Demo = Invoke-RestMethod "$Hub/api/v1/clients/onboard" -Method Post -Headers $Admin -ContentType $Json -TimeoutSec 300 -ErrorAction Stop -Body (@{
      company_name = "Demo Company"; subdomain = "demo"; contact_email = "owner@demo-company.com"; openrouter_api_key = "sk-or-v1-localtestplaceholder"
    } | ConvertTo-Json)
    $DemoLink = Invoke-RestMethod "$Hub/api/v1/clients/$($Demo.client_id)/portal-token" -Method Post -Headers $Admin -ContentType $Json -ErrorAction Stop -Body '{"ttl_days": 90}'
  } catch {
    Fail "Could not create the demo client: $(Get-ApiError $_)"
  }
  if ($Demo.warning) { Warn $Demo.warning }

  $Demo | ConvertTo-Json | Set-Content -Encoding ascii $DemoFile
  $DemoLink | ConvertTo-Json | Set-Content -Encoding ascii $LinkFile
  @"
========================= YOUR LOGINS =========================
Status: $($Demo.status)

AGENCY CONSOLE (your team)
  Open:       $Web/admin
  Click:      Connect hub
  Admin key:  $AdminKey

CLIENT DASHBOARD (Demo Company's control panel)
  Open:       $($Demo.dashboard_url)
  Username:   $($Demo.dashboard_username)
  Password:   $($Demo.dashboard_password)

CLIENT PORTAL (Demo Company's business owner)
  Open this link:
  $($DemoLink.portal_url)
  Or open $Web/portal/demo and paste this access key:
  $($DemoLink.token)

CLIENT API (for programs)
  Address:    $($Demo.api_base_url)
  API key:    $($Demo.api_key)

DATABASE
  docker exec -it hermes-postgres psql -U $(Get-EnvValue "POSTGRES_USER") -d $(Get-EnvValue "POSTGRES_DB")
===============================================================
"@ | Set-Content -Encoding ascii $LoginsFile
  $HaveLogins = $true
  $DemoId = $Demo.client_id
} else {
  $DemoId = $Existing.id
}

# -------------------------------------------------------------------- checks
if ($Existing -and $Existing.subscription_status -eq "archived") {
  Warn "The demo client is archived, so its subdomain is still taken. To remove it for good, see 6.8 in LOCAL_TESTING.md."
} else {
  Say "Checking the demo client"
  $Healthy = $false
  $Deadline = (Get-Date).AddSeconds(90)
  do {
    try { $Healthy = (Invoke-RestMethod "$Hub/api/v1/clients/$DemoId/health" -Headers $Admin -ErrorAction Stop).healthy } catch { $Healthy = $false }
    if (-not $Healthy) { Start-Sleep -Seconds 5 }
  } until ($Healthy -or (Get-Date) -gt $Deadline)

  # Never clean up from here: that deletes data, so it is the user's decision.
  if (-not $Healthy) {
    Warn "The demo client is not answering. If you restarted Docker Desktop, its files may be gone (test I4 in LOCAL_TESTING.md). The fix is the Clean-up section there, which deletes all clients, and then running this again."
  }
}

# -------------------------------------------------------------------- finish
Write-Host ""
if ($HaveLogins) {
  Get-Content $LoginsFile
  Write-Host ""
  Write-Host "Saved in $LoginsFile"
} else {
  Warn "The demo client exists but its saved logins are gone, and the hub cannot show the password again."
  Write-Host "Agency console: $Web/admin"
  Write-Host "Admin key:      $AdminKey"
  Write-Host "To get new demo logins, remove the demo client (6.8 in LOCAL_TESTING.md) and run this again."
}

Write-Host ""
Write-Host "Running. Double-click stop.bat to stop it. Your data is kept." -ForegroundColor Green
if (-not $NoBrowser) { Start-Process "$Web/admin" }
