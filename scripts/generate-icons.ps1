$base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII="
$bytes = [System.Convert]::FromBase64String($base64)
New-Item -ItemType Directory -Force -Path resources | Out-Null
[System.IO.File]::WriteAllBytes("resources/icon.png", $bytes)
Write-Host "Wrote resources/icon.png"