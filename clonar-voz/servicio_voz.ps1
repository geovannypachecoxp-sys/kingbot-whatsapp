# Supervisor del servicio de clonacion de voz y tunel inverso con la VPS
$Host.UI.RawUI.WindowTitle = "Kingbot Voice Cloning Service"

$clonarDir = "c:\Users\geova\OneDrive\Desktop\bot\clonar-voz"
$sshKey = "C:\Users\geova\.ssh\oracle-key.key"
$vpsHost = "ubuntu@161.153.93.239"

Write-Host "Iniciando servicio de clonacion de voz..."

while ($true) {
    # 1. Verificar FastAPI app.py
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/config" -TimeoutSec 3 -ErrorAction Stop
    } catch {
        Write-Host "Iniciando backend FastAPI app.py..."
        Start-Process -WindowStyle Hidden -FilePath "py" -ArgumentList "app.py" -WorkingDirectory $clonarDir
        Start-Sleep -Seconds 3
    }

    # 2. Verificar tunel SSH inverso
    $sshProc = Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*8080:127.0.0.1:8080*" -or $_.Id -gt 0 }
    $tunnelAlive = $false
    if ($sshProc) {
        $tunnelAlive = $true
    }

    if (-not $tunnelAlive) {
        Write-Host "Iniciando tunel SSH hacia VPS..."
        $args = "-i `"$sshKey`" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -N -R 8080:127.0.0.1:8080 $vpsHost"
        Start-Process -WindowStyle Hidden -FilePath "ssh" -ArgumentList $args
    }

    Start-Sleep -Seconds 30
}
