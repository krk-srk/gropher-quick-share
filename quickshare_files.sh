#!/bin/bash

# This script automates the GopherDrop Pro backend setup
# based on the selected instructions in the Installation Guide.

echo "🚀 Starting GopherDrop Pro Backend Setup..."

# Create directory and enter it
echo "📁 Creating server directory..."
mkdir -p server && cd server

# Initialize Go module
echo "📦 Initializing Go module..."
go mod init gopherdrop-server

# Install dependencies
echo "📥 Installing Gorilla WebSocket..."
go get github.com/gorilla/websocket

echo "------------------------------------------------"
echo "✅ Setup complete!"
echo "1. Please save your 'SignalingServer' code as 'main.go' inside the /server folder."
echo "2. Run the server using: go run main.go"
echo "------------------------------------------------"
