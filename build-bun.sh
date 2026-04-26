#!/bin/bash
# Sử dụng đường dẫn tuyệt đối đến bun trong cli-bin
BUN_BIN="/home/maple/.picoclaw/workspace/cli-bin/bun"

# Thêm cli-bin vào PATH để các script con của bun có thể tìm thấy bun
export PATH="/home/maple/.picoclaw/workspace/cli-bin:$PATH"

echo "Resuming build process for signetai package..."
$BUN_BIN install
$BUN_BIN run build:signetai
