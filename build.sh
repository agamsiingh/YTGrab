#!/usr/bin/env bash
set -e

echo "📦 Installing npm dependencies..."
npm install

echo "📥 Installing yt-dlp binary..."
# Download the latest yt-dlp binary into the project
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp
chmod +x ./yt-dlp

echo "✅ yt-dlp version:"
./yt-dlp --version

# Ensure temp directory exists
mkdir -p temp

echo "✅ Build complete!"
