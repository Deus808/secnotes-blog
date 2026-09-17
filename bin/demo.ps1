# SecNotes one-click demo (SSH reverse tunnel via localhost.run)
# Steps: stop admin.py -> read-only static server on 8090 -> ssh tunnel -> copy URL to clipboard.
# Entry point: demo.bat in the same folder (user double-clicks it).
# Requires Windows PowerShell 5.1+ and the built-in OpenSSH client.
#
# ASCII-ONLY FILE. Do NOT add non-ASCII text or hardcode a non-ASCII path:
# PowerShell 5.1 reads BOM-less .ps1 using the OEM codepage, so non-ASCII bytes
# would be decoded wrongly. The project root is derived from this script's own
# location instead of being hardcoded.
#
# NOTE ON PROCESS LAUNCHING:
# We deliberately avoid the Start-Process cmdlet. On PS 5.1 it rebuilds the child
# environment into a case-insensitive dictionary and throws
# "An item with the same key has already been added" whenever the environment
# contains keys differing only in case (Path/PATH, HTTP_PROXY/http_proxy, ...).
# That happens as soon as -RedirectStandardOutput/-RedirectStandardError is used,
# and both names exist on most Windows machines. System.Diagnostics.Process does
# not have this defect, so all child processes are started through it.
#
# WHY NOT localtunnel:
# This network cannot reach localtunnel.me:443 (TCP timeout, no RST), so the
# official client hangs silently forever. Port 80 is reachable but the client's
# control channel still fails. localhost.run over port 22 connects in ~3s and
# needs no npm package at all.
#
# KNOWN LIMITATION (read this before trusting the link):
# The tunnel gateway *.lhr.life is RESET (TLS-stage) from mainland China
# networks, so the tunnel comes up but visitors there cannot open the URL.
# The same applies to localtunnel.me / bore.pub / pinggy.io / ngrok-free.app.
# Reachable alternatives measured on 2026-09-12: cpolar.com, natapp.cn,
# natfrp.com (SakuraFrp), oray.com - all mainland providers, and all requiring
# an account token. For mainland visitors use one of those, or self-host frp.
# That is exactly why Step "Checking the URL is reachable" exists below: it
# refuses to present a URL as usable when it cannot actually be fetched.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { & chcp.com 65001 | Out-Null } catch {}

# ---------- Config ----------
# demo.ps1 lives in <project>\bin\, so the project root is its parent folder.
$ROOT         = Split-Path -Parent $PSScriptRoot
$PORT         = 8090

# Force UTF-8 for child Python processes. Rationale (same as start-admin.bat):
# a GBK console cannot encode emoji, and our Python tools print emoji in their
# summaries, which would abort them with UnicodeEncodeError.
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
# Python 解释器：默认用 PATH 里的 `python`；也可改成你机器上的绝对路径，
# 检测逻辑见下方「Environment check」。
$PY           = 'python'
$SSH          = ''
$TUN_HOST     = 'localhost.run'
$TUN_USERHOST = 'nokey@localhost.run'
$TUN_PORT     = 22
$URL_RE       = 'https://[a-z0-9-]+\.lhr\.life'
$WAIT_SECS    = 60
$LOG_DIR      = Join-Path $ROOT '.workbuddy\memory'
$LT_LOG       = Join-Path $LOG_DIR 'demo-tunnel.log'
$SRV_LOG      = Join-Path $LOG_DIR 'demo-server.log'

# ---------- Helpers ----------
function Write-Step($i, $total, $text) {
    Write-Host ''
    Write-Host "[$i/$total] $text" -ForegroundColor Cyan
}

# Locale-independent port probe. Returns $true when something is listening.
# (Parsing netstat output is unreliable: its state column can be localized.)
function Test-PortBusy($port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar  = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        $done = $iar.AsyncWaitHandle.WaitOne(700, $false)
        if (-not $done) { return $false }
        try { $c.EndConnect($iar) } catch { return $false }
        return $true
    } catch {
        return $false
    } finally {
        try { $c.Close() } catch {}
    }
}

# Generic outbound TCP reachability probe, used as a preflight check.
function Test-TcpReachable($hostName, $tcpPort, $timeoutMs) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar  = $c.BeginConnect($hostName, $tcpPort, $null, $null)
        $done = $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)
        if (-not $done) { return $false }
        try { $c.EndConnect($iar) } catch { return $false }
        return $true
    } catch {
        return $false
    } finally {
        try { $c.Close() } catch {}
    }
}

function Find-Ssh() {
    $cands = @()
    if ($env:SystemRoot) { $cands += (Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe') }
    $cands += 'C:\Windows\System32\OpenSSH\ssh.exe'
    foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    try {
        $cmd = Get-Command ssh.exe -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { return $cmd.Source }
    } catch {}
    return $null
}

function Get-ChildPids($parentId) {
    # Use CIM instead of wmic: wmic.exe was removed from recent Windows 11 builds.
    $pids = @()
    try {
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId" -ErrorAction SilentlyContinue
        foreach ($k in $kids) { $pids += [int]$k.ProcessId }
    } catch {}
    return $pids
}

# PID of whatever is LISTENING on the port, or 0 when free.
# netstat is used instead of Get-NetTCPConnection so this also works on older hosts.
function Get-ListeningPid($port) {
    try {
        $lines = & netstat.exe -ano 2>$null
        foreach ($l in $lines) {
            if ($l -match "[:\s]$port\s" -and $l -match 'LISTENING\s+(\d+)\s*$') {
                return [int]$matches[1]
            }
        }
    } catch {}
    return 0
}

# Remove leftovers from a previous demo run that was force-closed (clicking the
# window X bypasses the normal cleanup, orphaning the child processes).
# Only processes that are unmistakably ours are touched:
#   - python.exe running "http.server <our port>"
#   - ssh.exe talking to localhost.run
# Anything else is left alone and reported instead.
function Clear-StaleDemo {
    $killed = @()
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine -match 'http\.server' -and $p.CommandLine -match "[:\s]=?$PORT(\s|$)") {
                try {
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                    $killed += "stale http.server (pid $($p.ProcessId))"
                } catch {}
            }
        }
    } catch {}
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine -match 'localhost\.run') {
                try {
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                    $killed += "stale ssh tunnel (pid $($p.ProcessId))"
                } catch {}
            }
        }
    } catch {}
    return $killed
}

# Starts a hidden child process and drains its stdout/stderr into a thread-safe
# queue. Returns a hashtable @{ Proc = <Process>; Queue = <ConcurrentQueue> }.
function Start-Daemon($File, $CmdArgs, $WorkDir) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $File
    $psi.Arguments              = $CmdArgs
    $psi.WorkingDirectory       = $WorkDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardInput  = $true    # held open and never written -> child never sees EOF
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo           = $psi
    $proc.EnableRaisingEvents = $true

    $queue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
    $action = {
        if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
    }
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived `
        -Action $action -MessageData $queue | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived `
        -Action $action -MessageData $queue | Out-Null

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    return @{ Proc = $proc; Queue = $queue }
}

function Get-DaemonText($d) {
    if ($null -eq $d) { return '' }
    try { return (($d.Queue.ToArray()) -join "`n") } catch { return '' }
}

function Stop-Daemon($d) {
    if ($null -eq $d) { return }
    try {
        $thePid = $d.Proc.Id
        foreach ($k in (Get-ChildPids $thePid)) {
            try { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue } catch {}
        }
        if (-not $d.Proc.HasExited) {
            Stop-Process -Id $thePid -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Save-Log($text, $path) {
    try {
        if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }
        $text | Out-File -FilePath $path -Encoding utf8
    } catch {}
}

# Verifies the public URL is actually fetchable from this machine.
# This matters because a tunnel can come up successfully while its public
# gateway is blocked by the local network - the script would otherwise report
# a "success" URL that no visitor can open.
# Returns the HTTP status code, or 0 when unreachable.
function Test-PublicUrl($u) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($u)
        $req.Method = 'HEAD'
        $req.Timeout = 15000
        $req.AllowAutoRedirect = $true
        $req.Proxy = $null          # test the direct path, like a visitor would
        $req.UserAgent = 'SecNotes-demo-check'
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch {
        return 0
    }
}

# ---------- Environment check ----------
# 解析 $PY：若是纯命令名（如 python）则取其在 PATH 中的绝对路径，供 -File 使用。
$pyCmd = Get-Command $PY -ErrorAction SilentlyContinue
if (-not $pyCmd) { $pyCmd = Get-Command python.exe -ErrorAction SilentlyContinue }
if (-not $pyCmd) {
    Write-Host ''
    Write-Host "[ERROR] python not found: $PY (and 'python.exe' not on PATH)" -ForegroundColor Red
    Write-Host '        Install Python 3.8+, or fix the path at the top of demo.ps1.' -ForegroundColor Gray
    exit 1
}
$PY = $pyCmd.Source
if (-not (Test-Path (Join-Path $ROOT 'index.html'))) {
    Write-Host ''
    Write-Host '[ERROR] Project root not detected.' -ForegroundColor Red
    Write-Host "        resolved: $ROOT" -ForegroundColor Gray
    Write-Host '        Keep demo.ps1 inside the project bin\ folder.' -ForegroundColor Gray
    exit 1
}
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
}

$SSH = Find-Ssh
if (-not $SSH) {
    Write-Host ''
    Write-Host '[ERROR] ssh.exe not found.' -ForegroundColor Red
    Write-Host '        Enable the Windows optional feature "OpenSSH Client":' -ForegroundColor Gray
    Write-Host '        Settings > System > Optional features > Add a feature > OpenSSH Client' -ForegroundColor Gray
    exit 1
}
Write-Host ''
Write-Host "  ssh     : $SSH" -ForegroundColor DarkGray
Write-Host "  serving : $ROOT" -ForegroundColor DarkGray

# ---------- Step 1: stop admin.py ----------
try {
    Write-Step 1 4 'Stopping admin.py (prevent /api/* exposure)...'
    $adminProcs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*admin.py*' }
    if ($adminProcs) {
        foreach ($p in $adminProcs) {
            Write-Host "    killing PID $($p.ProcessId)" -ForegroundColor Yellow
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
        Start-Sleep -Seconds 1
        Write-Host '    admin.py stopped.' -ForegroundColor Green
    } else {
        Write-Host '    admin.py not running.' -ForegroundColor Gray
    }
} catch {
    Write-Host "    (process query failed, skipping: $_)" -ForegroundColor Gray
}

# ---------- Step 2: port check + stale cleanup + tunnel reachability ----------
Write-Step 2 4 "Checking port $PORT and tunnel reachability..."
if (Test-PortBusy $PORT) {
    Write-Host "    port $PORT is busy - looking for leftovers from a previous run..." -ForegroundColor Yellow
    $stale = Clear-StaleDemo
    if ($stale.Count -gt 0) {
        foreach ($s in $stale) { Write-Host "    cleaned: $s" -ForegroundColor Yellow }
        for ($t = 0; $t -lt 10; $t++) {
            Start-Sleep -Milliseconds 500
            if (-not (Test-PortBusy $PORT)) { break }
        }
    }
    if (Test-PortBusy $PORT) {
        Write-Host "[ERROR] Port $PORT is still in use by another program." -ForegroundColor Red
        $ownerPid = Get-ListeningPid $PORT
        if ($ownerPid -gt 0) {
            Write-Host "        pid : $ownerPid" -ForegroundColor Gray
            $pi = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
            if ($pi) {
                Write-Host "        name: $($pi.Name)" -ForegroundColor Gray
                Write-Host "        cmd : $($pi.CommandLine)" -ForegroundColor Gray
            }
            Write-Host "        To free it:  taskkill /PID $ownerPid /F" -ForegroundColor Gray
        }
        Write-Host "        Or change the port at the top of demo.ps1." -ForegroundColor Gray
        exit 1
    }
}
Write-Host '    port free.' -ForegroundColor Gray

if (-not (Test-TcpReachable $TUN_HOST $TUN_PORT 8000)) {
    Write-Host "[ERROR] Cannot reach $TUN_HOST port $TUN_PORT (TCP timeout)." -ForegroundColor Red
    Write-Host '        Your network appears to block outbound SSH (port 22).' -ForegroundColor Gray
    Write-Host '        Options: allow port 22 in the firewall/proxy, or self-host a tunnel' -ForegroundColor Gray
    Write-Host '        (frp on a VPS is the most stable long-term choice).' -ForegroundColor Gray
    exit 1
}
Write-Host "    $TUN_HOST port $TUN_PORT reachable." -ForegroundColor Gray

# ---------- Step 3: read-only static server ----------
Write-Step 3 4 "Starting read-only static server on 127.0.0.1:$PORT ..."
$srv = Start-Daemon -File $PY `
    -CmdArgs "-m http.server $PORT --bind 127.0.0.1" `
    -WorkDir $ROOT

$alive = $false
for ($t = 0; $t -lt 20; $t++) {
    Start-Sleep -Milliseconds 500
    if (Test-PortBusy $PORT) { $alive = $true; break }
    try { if ($srv.Proc.HasExited) { break } } catch {}
}

if (-not $alive) {
    Write-Host '[ERROR] Static server failed to start.' -ForegroundColor Red
    Write-Host "        working dir: $ROOT" -ForegroundColor Gray
    $srvText = Get-DaemonText $srv
    if ($srvText) {
        Write-Host '        output:' -ForegroundColor Gray
        foreach ($l in ($srvText -split "`n")) { Write-Host "          $l" -ForegroundColor DarkGray }
    }
    Save-Log $srvText $SRV_LOG
    Stop-Daemon $srv
    exit 1
}
Write-Host "    OK http://127.0.0.1:$PORT/ ready" -ForegroundColor Green

# ---------- Step 4: ssh reverse tunnel ----------
Write-Step 4 4 'Opening SSH reverse tunnel (localhost.run)...'
Write-Host '        The public URL will be copied to your clipboard.' -ForegroundColor Yellow

$sshArgs = @(
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', "80:localhost:$PORT",
    $TUN_USERHOST
) -join ' '

$tun = Start-Daemon -File $SSH -CmdArgs $sshArgs -WorkDir $ROOT

$esc = [char]27
$url = $null
Write-Host '    waiting for URL...' -NoNewline
for ($i = 0; $i -lt $WAIT_SECS; $i++) {
    Start-Sleep -Seconds 1
    if ((($i + 1) % 10) -eq 0) {
        Write-Host ('[{0}s]' -f ($i + 1)) -NoNewline -ForegroundColor DarkGray
    } else {
        Write-Host '.' -NoNewline
    }
    $text = Get-DaemonText $tun
    if ($text) {
        $clean = $text -replace "$esc\[[0-9;]*m", ''
        if ($clean -match $URL_RE) {
            $url = $matches[0].Trim()
            break
        }
    }
    try {
        if ($tun.Proc.HasExited) {
            Write-Host ''
            Write-Host "[WARN] ssh exited early (code $($tun.Proc.ExitCode))." -ForegroundColor Yellow
            break
        }
    } catch {}
}
Write-Host ''

$tunText = Get-DaemonText $tun
Save-Log $tunText $LT_LOG

if (-not $url) {
    Write-Host ''
    Write-Host "[FAILED] No public URL within $WAIT_SECS s." -ForegroundColor Red
    Write-Host "        log saved: $LT_LOG" -ForegroundColor Gray
    if ($tunText) {
        Write-Host '        last output:' -ForegroundColor Gray
        foreach ($l in (($tunText -split "`n") | Select-Object -Last 10)) {
            Write-Host "          $l" -ForegroundColor DarkGray
        }
    } else {
        Write-Host '        (ssh produced no output at all)' -ForegroundColor Gray
    }
    Stop-Daemon $tun
    Stop-Daemon $srv
    exit 1
}

Write-Host ''
Write-Host ('=' * 60) -ForegroundColor Green
Write-Host "  Public URL: $url" -ForegroundColor Green
Write-Host ('=' * 60) -ForegroundColor Green

# Do not declare success until the URL actually answers. A tunnel can be up
# while the gateway is unreachable from this network - the URL would be dead
# for every visitor, which is worse than an honest failure.
Write-Host '  Checking the URL is reachable ...' -NoNewline
$code = Test-PublicUrl $url
if ($code -ge 200 -and $code -lt 400) {
    Write-Host " OK (HTTP $code)" -ForegroundColor Green
} else {
    Write-Host ' FAILED' -ForegroundColor Red
    Write-Host ''
    Write-Host '  [!] The tunnel is up, but this URL does not answer from here.' -ForegroundColor Yellow
    Write-Host '      Most likely the gateway host is blocked by your network, so' -ForegroundColor Gray
    Write-Host '      visitors (especially in mainland China) will fail too.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '      What to do: see bin\README.md section "Gateway blocked in China".' -ForegroundColor Gray
    Write-Host '      Short version: use a mainland-China tunnel provider (cpolar /' -ForegroundColor Gray
    Write-Host '      natapp / SakuraFrp) or self-host frp on a VPS.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '      The link below is still shown in case only this machine is' -ForegroundColor DarkGray
    Write-Host '      affected and your visitors can reach it after all.' -ForegroundColor DarkGray
}
Write-Host ''

$clipOk = $false
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.Clipboard]::SetText($url)
    $clipOk = $true
} catch {
    try { $url | & clip.exe; $clipOk = $true } catch {}
}
if ($clipOk) {
    Write-Host '  Copied to clipboard.' -ForegroundColor Green
} else {
    Write-Host '  (clipboard failed; please copy the URL above manually)' -ForegroundColor Gray
}

Write-Host ''
Write-Host '  Visitor notes:' -ForegroundColor Yellow
Write-Host '    1) Open the URL directly - HTTPS is already terminated for you.' -ForegroundColor Gray
Write-Host '    2) No "Click to Continue" page and no tunnel password needed.' -ForegroundColor Gray
Write-Host '    3) The subdomain is random per run; a free account can pin it.' -ForegroundColor Gray
Write-Host '    4) Close this window or press any key to stop sharing.' -ForegroundColor Gray
Write-Host ''

Write-Host 'Press any key to stop and clean up...' -ForegroundColor Cyan
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch {}

# ---------- Cleanup ----------
Write-Host ''
Write-Host 'Cleaning up...' -ForegroundColor Cyan
Stop-Daemon $tun
Stop-Daemon $srv
Write-Host 'Done.' -ForegroundColor Green
exit 0
