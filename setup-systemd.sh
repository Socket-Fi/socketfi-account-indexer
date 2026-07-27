#!/bin/bash

SERVICE_NAME="socketfi-account-indexer"
APP_DIR="/home/tinkerpal/socketfi-account-indexer"
REPO_URL="git@github.com:Socket-Fi/socketfi-account-indexer.git"
DOCKER_COMPOSE_BIN="/usr/bin/docker compose"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ ! -d "$APP_DIR" ]; then
  echo "Error: App directory $APP_DIR does not exist."
  exit 1
fi

if [ -z "$DOCKER_COMPOSE_BIN" ]; then
  echo "Error: Docker Compose not found. Is Docker installed?"
  exit 1
fi

echo "Cleaning up unused Docker resources..."
docker system prune -f

echo "Pulling latest changes..."
cd "$APP_DIR"
git pull origin main || echo "Warning: Git pull failed, continuing..."

echo "Building Docker images..."
$DOCKER_COMPOSE_BIN build

echo "Creating systemd service file at $SERVICE_FILE..."

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=SocketFi Account Indexer (Docker Compose)
Requires=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=$APP_DIR
ExecStart=$DOCKER_COMPOSE_BIN up -d --build
ExecStop=$DOCKER_COMPOSE_BIN down
ExecReload=$DOCKER_COMPOSE_BIN up -d --build
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd and enabling service..."
sudo systemctl daemon-reexec
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}.service

echo "Systemd service '$SERVICE_NAME' has been created and enabled."
echo ""
echo "  Start:   sudo systemctl start $SERVICE_NAME"
echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
echo "  Status:  sudo systemctl status $SERVICE_NAME"
echo "  Logs:    docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "  Update:  sudo systemctl reload $SERVICE_NAME"
echo ""
read -p "Start the app now? (y/n): " choice

if [[ "$choice" =~ ^[Yy]$ ]]; then
  sudo systemctl start ${SERVICE_NAME}.service
  echo "Service started."
else
  echo "Start manually with: sudo systemctl start ${SERVICE_NAME}.service"
fi
