param(
    [Parameter(Mandatory=$true)][ValidateSet('start', 'stop')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Repository
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $Repository).Path
$config = Get-Content -LiteralPath (Join-Path $repo '.config/gridspace-lab.yml') -Raw | ConvertFrom-Json
$role = switch ($config.url) {
    'https://grid-space-misskey.kokopi.me' { 'g' }
    'https://resonite-love-misskey.kokopi.me' { 'r' }
    default { throw 'Refusing to control a server outside the dedicated G/R lab.' }
}
$expectedPort = if ($role -eq 'g') { 13000 } else { 13001 }
$expectedDbPort = if ($role -eq 'g') { 15432 } else { 25432 }
if ($config.db.port -ne $expectedDbPort -or $config.port -ne $expectedPort -or $config.db.host -ne '127.0.0.1' -or $config.db.db -ne 'misskey') { throw 'Unexpected lab configuration.' }
$pidPath = Join-Path $repo ".config/server-$role.pid"
$runner = Join-Path $repo 'scripts/gridspace/run-lab.ps1'
$all = @(Get-CimInstance Win32_Process)
$wrapper = $null
if (Test-Path -LiteralPath $pidPath) {
    $serverPid = [int](Get-Content -LiteralPath $pidPath)
    $wrapper = $all | Where-Object ProcessId -eq $serverPid
    if ($wrapper -and ($wrapper.CommandLine -notlike "*$runner*" -or $wrapper.CommandLine -notlike '*-Action start*')) { throw 'PID no longer belongs to this lab server.' }
}
if ($Action -eq 'stop') {
    if ($wrapper) {
        $descendants = [System.Collections.Generic.List[int]]::new()
        $descendants.Add([int]$wrapper.ProcessId)
        for ($index=0; $index -lt $descendants.Count; $index++) {
            foreach ($child in $all | Where-Object ParentProcessId -eq $descendants[$index]) { $descendants.Add([int]$child.ProcessId) }
        }
        for ($index=$descendants.Count-1; $index -ge 0; $index--) { Stop-Process -Id $descendants[$index] -ErrorAction SilentlyContinue }
    }
    Write-Output "Stopped lab server $role; database and tunnel retained."
} elseif (-not $wrapper) {
    $process = Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $repo -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$runner`"",'-Action','start') -RedirectStandardOutput (Join-Path $repo ".config/server-$role-admin.stdout.log") -RedirectStandardError (Join-Path $repo ".config/server-$role-admin.stderr.log") -PassThru
    Set-Content -LiteralPath $pidPath $process.Id
    Write-Output "Started lab server $role."
}
