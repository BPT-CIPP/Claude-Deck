# Claude Deck's pseudo-console host: runs Claude Code with its full terminal interface for a
# terminal inside the dashboard window (src/terminals.js, which starts this script).
#
# Windows' own conhost.exe --headless is the pseudo-console, the same thing Windows Terminal and
# node-pty use underneath: it reads keystrokes from its stdin and writes the screen to its stdout as
# VT sequences. Both are inherited from this script, so they are Claude Deck's own pipes and the
# bytes never pass through PowerShell. This script holds only what a pipe can't carry: the signal
# pipe conhost takes window resizes on (a handle it must inherit), and a control pipe back to
# Claude Deck. Windows PowerShell 5.1 and .NET built-ins only: nothing compiled, nothing installed.
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pty-host.ps1 -Spec <spec.json>
#
# spec.json: { command, cwd, width, height, control }
#   command  the client's full command line, quoted for CreateProcess (conhost starts it as is)
#   control  the name of a pipe Claude Deck listens on before starting this script
# Control pipe, one UTF-8 line per message.
#   From Claude Deck: "resize <columns> <rows>", "kill"
#   To Claude Deck:   "conhost <pid>", "claude <pid>", "exit <code>", "error <text>"
param([Parameter(Mandatory = $true)][string]$Spec)
$ErrorActionPreference = 'Stop'

# Not $spec: a variable is the parameter whatever its case, and [string] would turn the object to text.
$launch = [IO.File]::ReadAllText($Spec, [Text.Encoding]::UTF8) | ConvertFrom-Json

# Asynchronous, or ReadLineAsync below would block until a line came, and the loop couldn't also
# watch for conhost ending.
$control = New-Object System.IO.Pipes.NamedPipeClientStream('.', $launch.control, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
$control.Connect(10000)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader($control, $utf8)
$writer = New-Object System.IO.StreamWriter($control, $utf8)
$writer.AutoFlush = $true
function Send([string]$line) {
  try { $writer.WriteLine($line) } catch { }
}

# conhost's signal pipe. A resize is three little-endian words: 8 (resize), columns, rows.
$signal = New-Object System.IO.Pipes.AnonymousPipeServerStream([System.IO.Pipes.PipeDirection]::Out, [System.IO.HandleInheritability]::Inheritable)
$handle = '0x{0:x}' -f $signal.ClientSafePipeHandle.DangerousGetHandle().ToInt64()

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:SystemRoot 'System32\conhost.exe'
$psi.Arguments = "--headless --width $([int]$launch.width) --height $([int]$launch.height) --signal $handle -- " + $launch.command
$psi.WorkingDirectory = $launch.cwd
$psi.UseShellExecute = $false
# Not CreateNoWindow: that gives the child a hidden console of its own in place of our stdin and
# stdout, and the screen would go there instead of to Claude Deck.
$psi.CreateNoWindow = $false
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
  Send "error $($_.Exception.Message)"
  exit 2
}
$signal.DisposeLocalCopyOfClientHandle()
Send "conhost $($proc.Id)"

function Resize([int]$cols, [int]$rows) {
  $packet = [byte[]](8, 0) + [BitConverter]::GetBytes([uint16]$cols) + [BitConverter]::GetBytes([uint16]$rows)
  $signal.Write($packet, 0, $packet.Length)
  $signal.Flush()
}

# Claude is the client conhost started, so its pid is conhost's child's. Claude Deck reads Claude
# Code's own status file by that pid. Asked a few times, since the client takes a moment to appear.
function FindClaude {
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" | Select-Object -First 1
  if ($child) {
    Send "claude $($child.ProcessId)"
    return $true
  }
  return $false
}

$claudeFound = $false
$claudeTries = 0
$pending = $reader.ReadLineAsync()
while (-not $proc.HasExited) {
  $ready = $false
  try { $ready = $pending.Wait(200) } catch { break }
  if ($ready) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    $parts = $line.Split(' ')
    if ($parts[0] -eq 'resize' -and $parts.Length -eq 3) {
      try { Resize ([int]$parts[1]) ([int]$parts[2]) } catch { Send "error resize: $($_.Exception.Message)" }
    } elseif ($parts[0] -eq 'kill') {
      break
    }
    $pending = $reader.ReadLineAsync()
  }
  if (-not $claudeFound -and $claudeTries -lt 40) {
    $claudeTries++
    try { $claudeFound = FindClaude } catch { $claudeTries = 40; Send "error finding Claude's process: $($_.Exception.Message)" }
  }
}

# Asked to stop, or Claude Deck went away: end conhost and everything it started.
if (-not $proc.HasExited) {
  & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $proc.Id /T /F 2>&1 | Out-Null
  $proc.WaitForExit(5000) | Out-Null
}
$code = -1
if ($proc.HasExited) { $code = $proc.ExitCode }
Send "exit $code"
$signal.Dispose()
$control.Dispose()
exit 0
