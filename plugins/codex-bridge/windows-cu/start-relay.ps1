# Started once by codex-bridge through a one-shot Interactive scheduled task
# (conhost --headless, so no console window appears) so that the relay, its
# Computer Use pipe host/helper and every cua_repl it starts live in the user's
# desktop session. Derives the cua_repl launch spec from the Codex Desktop install,
# starts relay.mjs without a window and writes start.result.json for the caller.
param([int]$Port = 47614, [int]$IdleExitSec = 1800)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$result = Join-Path $dir 'start.result.json'
function Finish($fields) { $fields | ConvertTo-Json -Compress -Depth 4 | Set-Content $result -Encoding UTF8; exit 0 }
try {
  $tok = Join-Path $dir 'relay-token'
  if (-not (Test-Path $tok)) {
    $b = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    [IO.File]::WriteAllText($tok, ([Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')))
  }
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (-not (Test-Path $node)) { Finish @{ ok = $false; stage = 'node'; error = 'Node.js was not found on PATH or in Program Files' } }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $pluginDir = @('unified-computer-use', 'computer-use') |
    ForEach-Object { Join-Path $codexHome "plugins\cache\openai-bundled\$_" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $pluginDir) { Finish @{ ok = $false; stage = 'plugin'; error = 'Codex Computer Use plugin is not installed; enable Computer Use in Codex Desktop first' } }
  $codexData = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'
  $manifest = Join-Path $dir 'cua_repl.derived.mcp.json'
  # Windows PowerShell turns native stderr into terminating errors under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $derive = & $node (Join-Path $dir 'derive-manifest.mjs') --plugin-dir $pluginDir --runtimes-dir (Join-Path $codexData 'runtimes\cua_node') --codex-bin-dir (Join-Path $codexData 'bin') --out $manifest 2>&1 | Out-String
  $deriveExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $deriveJson = ($derive -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1)
  if ($deriveExit -ne 0) { Finish @{ ok = $false; stage = 'derive'; error = $(if ($deriveJson) { $deriveJson } else { $derive.Trim() }) } }

  $ready = Join-Path $dir 'relay.ready.json'
  Remove-Item $ready -ErrorAction SilentlyContinue
  $relayArgs = @((Join-Path $dir 'relay.mjs'), '--port', $Port, '--token-file', $tok, '--manifest-file', $manifest,
    '--log', (Join-Path $dir 'relay.log'), '--ready-file', $ready, '--idle-exit-sec', $IdleExitSec) |
    ForEach-Object { '"' + $_ + '"' }
  # CreateNoWindow: the relay gets a console without a window and outlives this script.
  $psi = New-Object Diagnostics.ProcessStartInfo $node, ($relayArgs -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $dir
  $p = [Diagnostics.Process]::Start($psi)
  for ($i = 0; $i -lt 60 -and -not (Test-Path $ready) -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $ready)) { Finish @{ ok = $false; stage = 'relay'; error = "relay did not become ready (exited=$($p.HasExited))"; pid = $p.Id } }
  Finish @{ ok = $true; pid = $p.Id; session = $p.SessionId; port = $Port; derive = ($deriveJson | ConvertFrom-Json) }
} catch {
  Finish @{ ok = $false; stage = 'script'; error = $_.Exception.Message }
}
