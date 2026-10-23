#requires -Version 5.1
[CmdletBinding()]
param([switch]$Pair, [switch]$Forget)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This companion requires Windows.' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run powershell.exe -STA -File .\Start-CloudHarness.ps1' }
if (-not [Environment]::UserInteractive) { throw 'Run this companion in an interactive desktop session.' }
$stateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CloudHarness'
$statePath = Join-Path $stateDirectory 'companion.xml'
if ($Forget) {
  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
  Write-Host 'Local pairing removed. Also disconnect the device in Cloud Harness settings.'
  return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  return ([Net.NetworkCredential]::new('', $secure)).Password
}
function Require-Origin([string]$Value) {
  $uri = [Uri]$Value
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Use an HTTPS origin, for example https://harness.example.com, without a path or credentials.' }
  return $uri.GetLeftPart([UriPartial]::Authority)
}
function Call-Server([string]$Origin, [string]$Route, [object]$Body, [string]$DeviceToken = '') {
  $headers = @{}
  if ($DeviceToken) { $headers.Authorization = 'Bearer ' + $DeviceToken }
  # No redirects: the pairing code or device credential must never travel to a different origin.
  return Invoke-RestMethod -Method Post -Uri ($Origin + $Route) -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8 -Compress))) -TimeoutSec 20 -MaximumRedirection 0
}
if ($Pair -or -not (Test-Path -LiteralPath $statePath)) {
  $origin = Require-Origin (Read-Host 'Cloud Harness HTTPS server address')
  $code = Read-SecretText 'One-use pairing code from Settings > Devices'
  $name = Read-Host 'Name for this Windows computer'
  if (-not $name.Trim() -or $name.Length -gt 80) { throw 'Choose a device name between 1 and 80 characters.' }
  $paired = Call-Server $origin '/api/computer/pair' @{ token = $code; name = $name; platform = 'windows' }
  $code = $null
  if ($paired.token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Server returned an invalid credential.' }
  New-Item -Path $stateDirectory -ItemType Directory -Force | Out-Null
  $credential = [Management.Automation.PSCredential]::new($paired.deviceId, (ConvertTo-SecureString $paired.token -AsPlainText -Force))
  # Windows Export-Clixml uses DPAPI, bound to this Windows user and machine.
  [pscustomobject]@{ Origin = $origin; Credential = $credential } | Export-Clixml -LiteralPath $statePath
  $paired = $null
}
$state = Import-Clixml -LiteralPath $statePath
$origin = Require-Origin $state.Origin
$token = $state.Credential.GetNetworkCredential().Password
if ($token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Pair again: stored credential is invalid.' }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'DesktopActions.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing
[CloudHarness.DesktopActions]::Initialize()
Write-Host ('Connected to ' + $origin + '. Each action asks locally. Close this window or press Ctrl+C to stop.')
while ($true) {
  $lease = $null
  try {
    $lease = Call-Server $origin '/api/computer/poll' @{ width = [CloudHarness.DesktopActions]::Width; height = [CloudHarness.DesktopActions]::Height } $token
    if ($null -ne $lease) {
      if ($lease.id -notmatch '^[0-9a-z]{26}$' -or $lease.lease -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid action lease.' }
      $description = switch ($lease.action.kind) {
        'screenshot' { 'Capture the primary screen and send it for one-time viewing in Cloud Harness. It will not be sent to an AI model.' }
        'click' { 'Click the primary screen at (' + $lease.action.x + ', ' + $lease.action.y + ').' }
        'type' { "Type this exact text into the current window:`n`n" + $lease.action.text }
        default { throw 'Unsupported action.' }
      }
      $result = @{ lease = $lease.lease; success = $false }
      if ([CloudHarness.DesktopActions]::Confirm($description, $origin)) {
        # Authorize after local confirmation. A revoked, cancelled or expired action must never execute.
        $authorization = Call-Server $origin ('/api/computer/actions/' + $lease.id + '/authorize') @{ lease = $lease.lease } $token
        if ($authorization.authorized -ne $true) { throw 'Action is no longer authorized.' }
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$authorization.expiresAt) { throw 'Action authorization expired.' }
        try {
          switch ($lease.action.kind) {
            'screenshot' { $result.screenshot = [CloudHarness.DesktopActions]::Screenshot() }
            'click' { [CloudHarness.DesktopActions]::Click([int]$lease.action.x, [int]$lease.action.y) }
            'type' { [CloudHarness.DesktopActions]::TypeLiteral([string]$lease.action.text) }
          }
          $result.success = $true
        } catch { Write-Warning 'The desktop action could not be completed. No automatic retry will run.' }
      }
      Call-Server $origin ('/api/computer/actions/' + $lease.id + '/complete') $result $token | Out-Null
    }
  } catch {
    # Never print server responses, input text, pairing codes or credential-bearing request details.
    Write-Warning 'Connection or action authorization failed. Nothing will be automatically replayed. Check the server and Devices settings.'
  }
  $lease = $null
  Start-Sleep -Seconds 3
}
