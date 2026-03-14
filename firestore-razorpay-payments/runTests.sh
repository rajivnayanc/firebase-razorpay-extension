#!/bin/bash
# Run tests against the Firebase Emulator Suite

set -e

cd "$(dirname "$0")"

# Build the functions
echo "Building functions..."
cd functions
npm run build

# Run unit tests
echo "Running unit tests..."
npm test

echo ""
echo "✅ All tests passed!"
