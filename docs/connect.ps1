# Save this as connect.ps1 or run directly
$OS = "Windows_NT"
$ARCH = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "i686" }

# Map to binary
$binary = switch ("$OS-$ARCH") {
    "Windows_NT-x86_64" { "websocat.x86_64-pc-windows-gnu.exe" }
    "Windows_NT-i686" { "websocat.i686-pc-windows-gnu.exe" }
    default { Write-Error "Unsupported OS/ARCH: $OS-$ARCH"; exit 1 }
}

# Check if websocat exists
if (-not (Get-Command websocat -ErrorAction SilentlyContinue) -and -not (Test-Path ".\$binary")) {
    $response = Read-Host "Websocat not found. Install latest v4 release? (y/n)"
    if ($response -eq 'y') {
        Write-Host "Fetching latest v4 release from GitHub..."
        $releases = Invoke-RestMethod "https://api.github.com/repos/vi/websocat/releases"
        $latest = $releases | Where-Object { $_.tag_name -match "^v4" } | Select-Object -First 1
        
        if (-not $latest) {
            Write-Error "No v4 release found!"
            exit 1
        }
        
        $url = "https://github.com/vi/websocat/releases/download/$($latest.tag_name)/$binary"
        Write-Host "Downloading $url..."
        Invoke-WebRequest -Uri $url -OutFile ".\$binary"
        $websocatPath = ".\$binary"
    } else {
        Write-Error "Cannot continue without websocat."
        exit 1
    }
} else {
    $websocatPath = if (Get-Command websocat -ErrorAction SilentlyContinue) { "websocat" } else { ".\$binary" }
}

# Connect
Write-Host "Connecting to chat..."
& $websocatPath wss://chat-cp1p.onrender.com