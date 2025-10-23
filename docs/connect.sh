#!/usr/bin/env bash

# --- Detect OS & Arch ---
OS="$(uname -s 2>/dev/null || echo Windows_NT)"
ARCH="$(uname -m 2>/dev/null || if [ "$PROCESSOR_ARCHITECTURE" ]; then echo $PROCESSOR_ARCHITECTURE; else echo x86_64; fi)"

# --- Map OS/ARCH to Websocat binary ---
get_binary() {
  case "$OS-$ARCH" in
    Linux-x86_64) echo "websocat.x86_64-unknown-linux-musl" ;;
    Linux-aarch64) echo "websocat_max.aarch64-unknown-linux-musl" ;;
    Darwin-x86_64) echo "websocat.x86_64-apple-darwin" ;;
    Darwin-arm64) echo "websocat.aarch64-apple-darwin" ;;
    Windows_NT-x86_64) echo "websocat.x86_64-pc-windows-gnu.exe" ;;
    Windows_NT-i686) echo "websocat.i686-pc-windows-gnu.exe" ;;
    *) echo "Unsupported OS/ARCH: $OS-$ARCH" >&2; exit 1 ;;
  esac
}

BINARY=$(get_binary)

# --- Check if websocat exists ---
if ! command -v websocat &> /dev/null && [ ! -f "./$BINARY" ]; then
  read -p "Websocat not found. Install latest v4 release? (y/n) " yn
  case $yn in
    [Yy]* )
      echo "Fetching latest v4 release from GitHub..."
      API="https://api.github.com/repos/vi/websocat/releases"
      LATEST=$(curl -s $API | grep -oP '"tag_name":\s*"\K4[^"]*' | head -n 1)
      if [ -z "$LATEST" ]; then
        echo "No v4 release found!" >&2
        exit 1
      fi
      URL="https://github.com/vi/websocat/releases/download/$LATEST/$BINARY"
      echo "Downloading $URL..."
      if [[ "$OS" == "Windows_NT" ]]; then
        curl -L -o ./$BINARY $URL
      else
        curl -L -o ./websocat $URL
        chmod +x ./websocat
        BINARY="./websocat"
      fi
      ;;
    * )
      echo "Cannot continue without websocat." >&2
      exit 1
      ;;
  esac
else
  BINARY=$(command -v websocat || echo "./$BINARY")
fi

# --- Connect to WebSocket chat ---
echo "Connecting to chat..."
"$BINARY" wss://chat-cp1p.onrender.com