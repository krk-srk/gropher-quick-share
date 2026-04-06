# Step 1: Build the Go binary (Updated to Go 1.24 to match your go.mod)
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum
COPY go.mod ./
# If you have a go.sum, uncomment the next line
# COPY go.sum ./

RUN go mod download

# Copy the source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -o signaling-server main.go

# Step 2: Create the production image
FROM alpine:latest

WORKDIR /root/

# Install wget for the health check
RUN apk add --no-cache wget

# Copy the binary from the builder
COPY --from=builder /app/signaling-server .

# Expose the port
EXPOSE 8080

# Health check for AWS App Runner/ECS
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the server
CMD ["./signaling-server"]
