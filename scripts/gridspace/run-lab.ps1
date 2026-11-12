param(
    [ValidateSet('build', 'migrate', 'start')]
    [string]$Action = 'start',
    [string]$Repository = (Join-Path $PSScriptRoot '../..')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $Repository).Path
$envPath = Join-Path $repo '.config/gridspace-lab.env'
$configPath = Join-Path $repo '.config/gridspace-lab.yml'
if (-not (Test-Path -LiteralPath $envPath) -or -not (Test-Path -LiteralPath $configPath)) {
    throw 'Run setup-lab.mjs first.'
}
foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^(GRIDSPACE_LAB_(?:DB_PASSWORD|PEER_KEY))=(.+)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$env:MISSKEY_CONFIG_YML = 'gridspace-lab.yml'
if ($Action -eq 'build') {
    # Workspace packages also need declaration outputs for type checking.
    Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
} else {
    $env:NODE_ENV = 'production'
}
$env:PATH = (Join-Path $repo 'node_modules/.bin') + [IO.Path]::PathSeparator + $env:PATH
Push-Location $repo
try {
    & node (Join-Path $repo 'node_modules/pnpm/bin/pnpm.cjs') $Action
    if ($LASTEXITCODE -ne 0) { throw ('Misskey {0} failed ({1}).' -f $Action, $LASTEXITCODE) }
} finally {
    Pop-Location
}
