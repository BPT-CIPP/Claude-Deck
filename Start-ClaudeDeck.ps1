#Requires -Version 5.1
<#
.SYNOPSIS
    Starts Claude Deck, opens its dashboard, and installs or removes it on this PC.

.DESCRIPTION
    With no switches: starts the Claude Deck local server (node src\server.js) in the background
    if it is not already running, then opens the dashboard: the installed Claude Deck app if you
    installed it from Edge, otherwise an Edge app window. Running it again while the server is up
    just opens another dashboard window.

    To set Claude Deck up on a PC, run it once with -Install.

.PARAMETER Install
    Sets Claude Deck up for the current user: checks prerequisites (Node.js 22+, and warns about a
    missing Windows Terminal, Claude Code or Edge), creates the "Start Claude Deck" shortcuts,
    registers the sign-in task (see -InstallStartup), starts the server and opens the dashboard.

.PARAMETER Uninstall
    Stops the server and removes the sign-in task and the shortcuts. Keeps your data folder
    (%LOCALAPPDATA%\ClaudeDeck) and never touches Claude Code's own files.

.PARAMETER InstallShortcut
    Creates "Start Claude Deck" shortcuts, with the Claude Deck icon, on the desktop and in the
    Start menu. They run this script without a console window.

.PARAMETER InstallStartup
    Registers a scheduled task, "Claude Deck", that runs the server in the background every time
    you sign in to Windows, as you. The task keeps it running: it restarts the server if it
    crashes, and leaves it stopped if you stop it on purpose (Preferences > Stop server now).

.PARAMETER RemoveStartup
    Removes the sign-in task (and the older Startup-folder shortcut, if present).

.PARAMETER Service
    Runs the server in this window and supervises it. This is what the sign-in task runs.

.PARAMETER NoWindow
    Starts the server in the background without opening a window, and keeps it running.

.PARAMETER Foreground
    Runs the server in this console instead of the background, with its log output visible.
    Stop it with Ctrl+C.

.EXAMPLE
    .\Start-ClaudeDeck.ps1 -Install

.EXAMPLE
    .\Start-ClaudeDeck.ps1

.EXAMPLE
    .\Start-ClaudeDeck.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$InstallShortcut,
    [switch]$InstallStartup,
    [switch]$RemoveStartup,
    [switch]$Service,
    [switch]$NoWindow,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptPath
$server = Join-Path $root 'src\server.js'
$icon = Join-Path $root 'public\icons\claude-deck.ico'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskName = 'Claude Deck'
$legacyStartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Deck.lnk'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Claude Deck.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Start Claude Deck.lnk')
)
$dataDir = Join-Path $env:LOCALAPPDATA 'ClaudeDeck'

# Exit codes from src\server.js
$ExitStopped = 0         # stopped on purpose
$ExitAlreadyRunning = 3  # another copy is serving; nothing to do

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw 'Node.js was not found on PATH. Install Node.js 22 or later (https://nodejs.org), open a new PowerShell window, then run this again.'
}
$node = $nodeCmd.Source

function New-DeckShortcut {
    param([string]$Path, [string]$ScriptArgs, [string]$Description)
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $powershellExe
    $lnk.Arguments = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" {1}' -f $scriptPath, $ScriptArgs).Trim()
    $lnk.WorkingDirectory = $root
    $lnk.WindowStyle = 7
    $lnk.IconLocation = if (Test-Path -LiteralPath $icon) { '{0},0' -f $icon } else { '{0},0' -f $node }
    $lnk.Description = $Description
    $lnk.Save()
    Write-Output "Created $Path"
}

function Install-DeckShortcuts {
    foreach ($p in $shortcutPaths) {
        New-DeckShortcut -Path $p -ScriptArgs '' -Description 'Run and reply to Claude Code sessions'
    }
}

function Register-DeckTask {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Service' -f $scriptPath
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgs -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    # Interactive: runs in your desktop session, so Windows Terminal tabs and Edge windows appear.
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps the Claude Deck server running while you are signed in.' -Force | Out-Null
    } catch {
        throw "Could not create the '$taskName' sign-in task: $($_.Exception.Message) On some managed PCs creating scheduled tasks needs an administrator; you can still start Claude Deck with the Start Claude Deck shortcut."
    }
    Write-Output "Registered scheduled task '$taskName' (runs at sign-in as $user)"
    # The Startup-folder shortcut from earlier versions did the same job; don't run two.
    if (Test-Path -LiteralPath $legacyStartupLnk) {
        Remove-Item -LiteralPath $legacyStartupLnk -Force
        Write-Output "Removed the older startup shortcut $legacyStartupLnk"
    }
}

function Unregister-DeckTask {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "Removed scheduled task '$taskName'"
    }
    if (Test-Path -LiteralPath $legacyStartupLnk) {
        Remove-Item -LiteralPath $legacyStartupLnk -Force
        Write-Output "Removed $legacyStartupLnk"
    }
}

function Get-RunningServer {
    $runtime = Join-Path $dataDir 'runtime.json'
    $secret = Join-Path $dataDir 'secret.json'
    if (-not (Test-Path -LiteralPath $runtime) -or -not (Test-Path -LiteralPath $secret)) { return $null }
    $rt = Get-Content -LiteralPath $runtime -Raw | ConvertFrom-Json
    if (-not (Get-Process -Id $rt.pid -ErrorAction SilentlyContinue)) { return $null }
    $token = (Get-Content -LiteralPath $secret -Raw | ConvertFrom-Json).token
    return [pscustomobject]@{ Port = $rt.port; Pid = $rt.pid; Token = $token }
}

if ($Service) {
    # Supervise the server: restart after a crash, stop when it is stopped on purpose, and wait
    # while a copy started some other way is running (then take over when it stops).
    $crashes = New-Object System.Collections.Generic.List[datetime]
    while ($true) {
        & $node $server --resident
        $code = $LASTEXITCODE
        if ($code -eq $ExitStopped) { break }
        if ($code -eq $ExitAlreadyRunning) { Start-Sleep -Seconds 30; continue }
        $now = Get-Date
        $crashes.Add($now)
        $recent = @($crashes | Where-Object { $_ -gt $now.AddMinutes(-10) })
        if ($recent.Count -ge 5) { break }  # crashing repeatedly; try again at next sign-in
        Start-Sleep -Seconds 10
    }
    exit 0
}

if ($Install) {
    $nodeVersion = (& $node --version).Trim()
    if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.0.0') {
        throw "Claude Deck needs Node.js 22 or later; this PC has $nodeVersion. Install a current version from https://nodejs.org, then run this again."
    }
    Write-Output "Node.js $nodeVersion"
    if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
        Write-Warning 'Windows Terminal (wt.exe) was not found. Chats in Claude Deck work, but "run in a terminal" sessions will not.'
    }
    $claudeFound = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))
    if (-not $claudeFound) {
        Write-Warning 'Claude Code was not found. Install it, or set its path later under Preferences > Claude Code.'
    }
    $edgePaths = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
    if (-not ($edgePaths | Where-Object { Test-Path -LiteralPath $_ })) {
        Write-Warning 'Microsoft Edge was not found. The dashboard will open in your default browser instead.'
    }
    Install-DeckShortcuts
    Register-DeckTask
    Start-ScheduledTask -TaskName $taskName
    for ($i = 0; $i -lt 20 -and -not (Get-RunningServer); $i++) { Start-Sleep -Milliseconds 500 }
    # Opens the dashboard; if the task's server is up this just opens a window.
    Start-Process -FilePath $node -ArgumentList @("`"$server`"", '--open') -WorkingDirectory $root -WindowStyle Hidden
    Write-Output 'Claude Deck is installed. To pin it to the taskbar, see "Pin it to the taskbar" in README.md.'
    return
}

if ($Uninstall) {
    $running = Get-RunningServer
    if ($running) {
        try {
            Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:{0}/api/shutdown' -f $running.Port) -Headers @{ 'x-deck-token' = $running.Token } | Out-Null
            Write-Output 'Stopped the Claude Deck server'
        } catch {
            Write-Warning "Could not stop the running server: $($_.Exception.Message)"
        }
    }
    Unregister-DeckTask
    foreach ($p in $shortcutPaths) {
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Force
            Write-Output "Removed $p"
        }
    }
    Write-Output "Your Claude Deck data is still in $dataDir. Delete that folder to remove it too. If you installed the Claude Deck app from Edge, remove it from edge://apps."
    return
}

if ($InstallShortcut) {
    Install-DeckShortcuts
    return
}

if ($InstallStartup) {
    Register-DeckTask
    return
}

if ($RemoveStartup) {
    Unregister-DeckTask
    return
}

if ($Foreground) {
    & $node $server --open
    exit $LASTEXITCODE
}

# The server checks for a running instance itself: if one is up it just opens the window and exits.
$serverArgs = if ($NoWindow) { @("`"$server`"", '--resident') } else { @("`"$server`"", '--open') }
Start-Process -FilePath $node -ArgumentList $serverArgs -WorkingDirectory $root -WindowStyle Hidden
