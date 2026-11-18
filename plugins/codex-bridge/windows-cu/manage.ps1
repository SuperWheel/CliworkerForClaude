# Remote management for the codex-bridge Windows Computer Use relay. Runs over SSH
# (session 0) and prints one JSON line.
#   status  whether the relay runs, and in which session
#   start   launches start-relay.ps1 in the logged-on user's desktop session through
#           a one-shot Interactive scheduled task, removed again afterwards
#   stop    asks the relay to shut down, then confirms that the relay and every
#           process it started have exited (Stop-Process on the exact PID as fallback)
param([ValidateSet('status', 'start', 'stop')][string]$Action = 'status', [int]$Port = 47614, [int]$IdleExitSec = 1800)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$dir = $PSScriptRoot
$ready = Join-Path $dir 'relay.ready.json'
$relayScript = Join-Path $dir 'relay.mjs'

function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Get-Relay {
  if (-not (Test-Path $ready)) { return $null }
  $r = Get-Content $ready -Raw | ConvertFrom-Json
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$r.pid)" -ErrorAction SilentlyContinue
  if (-not $p -or $p.Name -ne 'node.exe' -or -not $p.CommandLine -or -not $p.CommandLine.Contains($relayScript)) { return $null }
  [pscustomobject]@{ pid = [int]$r.pid; session = $p.SessionId; port = [int]$r.port; startedUtc = $r.startedUtc; exe = $p.ExecutablePath; created = $p.CreationDate }
}
function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process
  $out = @(); $queue = @($root)
  while ($queue.Count) {
    $parent = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
    foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $parent -and $_.ProcessId -ne $root }) {
      $out += [pscustomobject]@{ pid = [int]$c.ProcessId; name = $c.Name; created = $c.CreationDate }; $queue += [int]$c.ProcessId
    }
  }
  $out
}
function Test-Alive($p) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.pid)" -ErrorAction SilentlyContinue
  [bool]($q -and $q.CreationDate -eq $p.created)
}
function Get-Desktop {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($e in Get-CimInstance Win32_Process -Filter "Name='explorer.exe'") {
    $o = Invoke-CimMethod -InputObject $e -MethodName GetOwner
    if ("$($o.Domain)\$($o.User)" -eq $me) { return [int]$e.SessionId }
  }
  $null
}

$cur = Get-Relay
switch ($Action) {
  'status' {
    Out-Json @{ ok = $true; running = [bool]$cur; relay = $(if ($cur) { $cur | Select-Object pid, session, port, startedUtc }); desktopSession = (Get-Desktop) }
  }
  'start' {
    if ($cur) { Out-Json @{ ok = $true; running = $true; started = $false; relay = ($cur | Select-Object pid, session, port, startedUtc) } }
    $desktop = Get-Desktop
    if ($null -eq $desktop) { Out-Json @{ ok = $false; stage = 'desktop'; error = 'this Windows user has no desktop session; log on to Windows first' } }
    $result = Join-Path $dir 'start.result.json'
    Remove-Item $result -ErrorAction SilentlyContinue
    $task = 'codex-bridge-windows-cu-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $ps = Join-Path $PSHOME 'powershell.exe'
    $arg = "--headless `"$ps`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'start-relay.ps1')`" -Port $Port -IdleExitSec $IdleExitSec"
    $taskAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') -Argument $arg -WorkingDirectory $dir
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $task -Action $taskAction -Principal $principal -Settings $settings | Out-Null
    try {
      Start-ScheduledTask -TaskName $task
      for ($i = 0; $i -lt 160 -and -not (Test-Path $result); $i++) { Start-Sleep -Milliseconds 250 }
      for ($i = 0; $i -lt 40 -and (Get-ScheduledTask -TaskName $task).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 250 }
    } finally {
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
    if (-not (Test-Path $result)) { Out-Json @{ ok = $false; stage = 'task'; error = 'start-relay.ps1 did not report within 40 s; make sure the Windows desktop is logged on and unlocked' } }
    $r = Get-Content $result -Raw | ConvertFrom-Json
    $cur = Get-Relay
    Out-Json @{ ok = [bool]($r.ok -and $cur); running = [bool]$cur; started = $true; desktopSession = $desktop; result = $r; relay = $(if ($cur) { $cur | Select-Object pid, session, port, startedUtc }) }
  }
  'stop' {
    if (-not $cur) { Remove-Item $ready -ErrorAction SilentlyContinue; Out-Json @{ ok = $true; running = $false; stopped = $false } }
    $tree = @(Get-Tree $cur.pid)
    $ErrorActionPreference = 'Continue'
    & $cur.exe (Join-Path $dir 'connect.mjs') $cur.port (Join-Path $dir 'relay-token') --stop 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    $method = 'graceful'
    for ($i = 0; $i -lt 40 -and (Test-Alive $cur); $i++) { Start-Sleep -Milliseconds 250 }
    if (Test-Alive $cur) {
      Stop-Process -Id $cur.pid
      $method = 'stop-process'
      for ($i = 0; $i -lt 40 -and (Test-Alive $cur); $i++) { Start-Sleep -Milliseconds 250 }
    }
    for ($i = 0; $i -lt 40 -and @($tree | Where-Object { Test-Alive $_ }).Count; $i++) { Start-Sleep -Milliseconds 250 }
    $left = @($tree | Where-Object { Test-Alive $_ } | ForEach-Object { "$($_.name):$($_.pid)" })
    $relayAlive = Test-Alive $cur
    if (-not $relayAlive) { Remove-Item $ready -ErrorAction SilentlyContinue }
    Out-Json @{ ok = (-not $relayAlive -and -not $left.Count); stopped = -not $relayAlive; pid = $cur.pid; method = $method; children = $tree.Count; leftover = $left }
  }
}
