#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# zk_faucet Setup Script
# =============================================================================
# Run: bash scripts/setup.sh
# This script prepares the project for development after a fresh clone.
# =============================================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

echo ""
echo "=== zk_faucet setup ==="
echo ""

# ---- Check dependencies ----

# Bun (required)
if command -v bun &> /dev/null; then
  info "bun $(bun --version) found"
else
  fail "bun is not installed. Install it: https://bun.sh"
fi

# nargo (optional — only needed for circuit development)
if command -v nargo &> /dev/null; then
  info "nargo $(nargo --version 2>&1 | head -1) found"
else
  warn "nargo not found (optional — only needed for Noir circuit development)"
fi

# Hardhat (via npx — will use local install)
if [ -f "node_modules/.bin/hardhat" ] || command -v npx &> /dev/null; then
  info "npx/hardhat available"
else
  warn "npx not found — contract compilation may not work"
fi

echo ""

# ---- Install dependencies ----

echo "Installing dependencies..."
bun install
info "Dependencies installed"

echo ""

# ---- Create .env if missing ----

if [ -f ".env" ]; then
  info ".env already exists (skipping)"
else
  cp .env.example .env
  info ".env created from .env.example"
  warn "Edit .env to set ORIGIN_RPC_URL and FAUCET_PRIVATE_KEY before running the server"
fi

echo ""

# ---- Compile contracts ----

echo "Compiling Solidity contracts..."
cd packages/contracts
npx hardhat compile
cd ../..
info "Contracts compiled"

echo ""

# ---- Build frontend ----

echo "Building frontend..."
cd packages/frontend
bun run build
cd ../..
info "Frontend built"

echo ""

# ---- Done ----

echo "==========================================="
echo ""
info "Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Edit .env with your ORIGIN_RPC_URL and FAUCET_PRIVATE_KEY"
echo "    2. Run: bun run dev"
echo "    3. Open: http://localhost:3000"
echo ""
echo "==========================================="
