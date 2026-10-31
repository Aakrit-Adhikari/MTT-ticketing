# One-click local run: creates secrets once (in .local/, git-ignored), starts DB, backend, frontend.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$be = Join-Path $root 'backend'; $fe = Join-Path $root 'frontend'
$local = Join-Path $root '.local'; New-Item -ItemType Directory -Force $local | Out-Null
$file = Join-Path $local 'secrets.json'

if (-not (Test-Path $file)) {
  Push-Location $be
  $s = @{
    JWT_ACCESS_SECRET    = (node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
    FIELD_ENCRYPTION_KEY = (node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
    ADMIN_EMAIL          = 'admin@local.test'
    ADMIN_PASSWORD       = (node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  }
  Pop-Location
  $s | ConvertTo-Json | Set-Content $file -Encoding utf8
}
$s = Get-Content $file -Raw | ConvertFrom-Json

foreach ($d in $be, $fe) { if (-not (Test-Path (Join-Path $d 'node_modules'))) { Push-Location $d; npm ci; Pop-Location } }

# Stop servers from a previous run so ports and files are free (your data is kept in .local\pgdata).
foreach ($port in 3000, 4000, 54329) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep 2

# Email settings live in .local\smtp.json (git-ignored). Until the app password is filled in, emails print in the BACKEND window.
$smtpFile = Join-Path $local 'smtp.json'
if (-not (Test-Path $smtpFile)) {
  @{ SMTP_HOST = 'smtp.gmail.com'; SMTP_PORT = '587'; SMTP_USER = 'aakritadhikari12@gmail.com'; SMTP_PASSWORD = 'PASTE_GMAIL_APP_PASSWORD_HERE';
     MAIL_FROM = 'Mountain Tours and Travels Ticketing <aakritadhikari12@gmail.com>'; STAFF_NOTIFY_EMAIL = 'aakritadhikari12@gmail.com' } | ConvertTo-Json | Set-Content $smtpFile -Encoding utf8
}
$smtp = Get-Content $smtpFile -Raw | ConvertFrom-Json
$mailBlock = ''
if ($smtp.SMTP_PASSWORD -and $smtp.SMTP_PASSWORD -notlike 'PASTE_*') {
  $mailBlock = "; `$env:SMTP_HOST='$($smtp.SMTP_HOST)'; `$env:SMTP_PORT='$($smtp.SMTP_PORT)'; `$env:SMTP_USER='$($smtp.SMTP_USER)'; `$env:SMTP_PASSWORD='$($smtp.SMTP_PASSWORD.Replace("'","''"))'; `$env:MAIL_FROM='$($smtp.MAIL_FROM)'"
  Write-Host "Email: REAL sending enabled via $($smtp.SMTP_HOST) as $($smtp.SMTP_USER)"
} else {
  Write-Host 'Email: not configured yet - emails will print in the BACKEND window. See .local\smtp.json'
}
$staffMail = if ($smtp.STAFF_NOTIFY_EMAIL) { $smtp.STAFF_NOTIFY_EMAIL } else { 'staff@local.test' }

$db = 'postgresql://test:test@localhost:54329/mtt'
$envBlock = "`$env:DATABASE_URL='$db'; `$env:JWT_ACCESS_SECRET='$($s.JWT_ACCESS_SECRET)'; `$env:FIELD_ENCRYPTION_KEY='$($s.FIELD_ENCRYPTION_KEY)'; `$env:FRONTEND_ORIGIN='http://localhost:3000'; `$env:PORT='4000'; `$env:NODE_ENV='development'; `$env:STAFF_NOTIFY_EMAIL='$staffMail'; `$env:AGENCY_NAME='Mountain Tours and Travels Ticketing'$mailBlock"

Write-Host 'Starting database...'
$ready = Join-Path $local 'db-ready'; Remove-Item $ready -ErrorAction SilentlyContinue
Start-Process powershell -WorkingDirectory $be -ArgumentList '-NoExit','-Command',"`$Host.UI.RawUI.WindowTitle='DATABASE (close to stop)'; `$env:READY_FILE='$ready'; `$env:PG_DATA_DIR='$local\pgdata'; node test/pg-server.mjs"
for ($i=0; $i -lt 90 -and -not (Test-Path $ready); $i++) { Start-Sleep 1 }
if (-not (Test-Path $ready)) { throw 'Database did not become ready' }

Push-Location $be
Write-Host 'Building backend...'; npm run build | Out-Null
Invoke-Expression $envBlock
$env:ADMIN_EMAIL = $s.ADMIN_EMAIL; $env:ADMIN_PASSWORD = $s.ADMIN_PASSWORD
$ErrorActionPreference = 'Continue'
node dist/scripts/create-admin.js 2>$null   # prints an error and is skipped if the admin already exists (data is kept between runs)
$ErrorActionPreference = 'Stop'
Pop-Location

Start-Process powershell -WorkingDirectory $be -ArgumentList '-NoExit','-Command',"`$Host.UI.RawUI.WindowTitle='BACKEND'; $envBlock; node dist/main.js"
Start-Process powershell -WorkingDirectory $fe -ArgumentList '-NoExit','-Command','$Host.UI.RawUI.WindowTitle="WEBSITE"; $env:PORT="3000"; npm run dev'

Write-Host ''
Write-Host '=============================================='
Write-Host ' Customer site : http://localhost:3000'
Write-Host ' Staff login   : http://localhost:3000/admin/login'
Write-Host " Email         : $($s.ADMIN_EMAIL)"
Write-Host " Password      : $($s.ADMIN_PASSWORD)"
Write-Host ' (give the website ~15 seconds to start)'
Write-Host ' Close the three windows to stop everything.'
Write-Host '=============================================='
