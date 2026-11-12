param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('g', 'r', 'e')]
    [string]$Role
)

$ErrorActionPreference = 'Stop'
$localPorts = @{ g = 13000; r = 13001; e = 13002 }
$subdomains = @{ g = 'grid-space-misskey'; r = 'resonite-love-misskey'; e = 'gridspace-e-dev' }
$forward = '{0}:80:127.0.0.1:{1}' -f $subdomains[$Role], $localPorts[$Role]
Write-Output ('Public test URL: https://{0}.kokopi.me' -f $subdomains[$Role])

while ($true) {
    & ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R $forward kokopi.me
    Write-Warning 'Test tunnel disconnected. Retrying in 5 seconds; press Ctrl-C to stop.'
    Start-Sleep -Seconds 5
}
