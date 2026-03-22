Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Action
  Write-Host "OK: $Name" -ForegroundColor Green
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = Resolve-Path (Join-Path $scriptDir "..")
  Set-Location $repoRoot

  Write-Host "Repository: $repoRoot" -ForegroundColor Yellow

  Invoke-Step -Name "npm run lint" -Action {
    npm.cmd run lint
  }

  Invoke-Step -Name "npm run build -- --emptyOutDir false" -Action {
    npm.cmd run build -- --emptyOutDir false
  }

  Invoke-Step -Name "cargo build (native/engine)" -Action {
    Push-Location (Join-Path $repoRoot "native/engine")
    try {
      cargo build
    }
    finally {
      Pop-Location
    }
  }

  Invoke-Step -Name "cargo build (native/spotify-connect-engine)" -Action {
    Push-Location (Join-Path $repoRoot "native/spotify-connect-engine")
    try {
      cargo build
    }
    finally {
      Pop-Location
    }
  }

  Invoke-Step -Name "npm run electron:build" -Action {
    npm.cmd run electron:build
  }

  Invoke-Step -Name "npm run build:unpack" -Action {
    npm.cmd run build:unpack
  }

  Write-Host ""
  Write-Host "All build steps completed successfully." -ForegroundColor Green
  exit 0
}
catch {
  Write-Host ""
  Write-Host "Build pipeline failed." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
