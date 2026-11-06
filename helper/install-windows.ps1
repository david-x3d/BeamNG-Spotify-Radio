# Installs the helper's dependencies and starts it with Windows (no console window).
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File install-windows.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
    Write-Host "Python not found. Install it from https://www.python.org (tick 'Add python.exe to PATH') and run this again."
    exit 1
}
& $python -m pip install --upgrade numpy winrt-runtime winrt-Windows.Foundation winrt-Windows.Foundation.Collections winrt-Windows.Media.Control

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "Installing ffmpeg with winget ..."
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    Write-Host "ffmpeg installed. If the helper cannot find it, log out and back in once."
}

if (-not (Test-Path "$dir\svcl.exe")) {
    Write-Host "Downloading NirSoft svcl (switches Spotify's output device) ..."
    $zip = Join-Path $env:TEMP "svcl-x64.zip"
    Invoke-WebRequest "https://www.nirsoft.net/utils/svcl-x64.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $dir -Force
    Remove-Item $zip
}

$cable = Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -like "*VB-Audio Virtual Cable*" }
if (-not $cable) {
    Write-Host "VB-CABLE is not installed. Get it from https://vb-audio.com/Cable/ (run the installer as admin, then reboot)."
}

$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
$startup = [Environment]::GetFolderPath("Startup")
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut("$startup\BeamNG Spotify Radio helper.lnk")
$link.TargetPath = $pythonw
$link.Arguments = "`"$dir\helper.py`""
$link.WorkingDirectory = $dir
$link.Save()

Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" | Where-Object { $_.CommandLine -like "*helper.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process $pythonw -ArgumentList "`"$dir\helper.py`"" -WorkingDirectory $dir
Write-Host "Helper installed and running, it starts with Windows from now on. Log: $dir\helper.log"
