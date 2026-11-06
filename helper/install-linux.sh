#!/bin/sh
# Installs the helper as a systemd user service that starts with your session.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

for tool in python3 pactl ffmpeg playerctl; do
  command -v "$tool" >/dev/null || echo "warning: $tool not found, install it with your package manager"
done
python3 -c "import numpy" 2>/dev/null || echo "warning: python numpy not found (e.g. python-numpy / python3-numpy)"

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/spotifyremote-radio.service" <<UNIT
[Unit]
Description=Spotify to BeamNG car radio bridge
After=pipewire-pulse.service

[Service]
ExecStart=/usr/bin/env python3 -u $DIR/helper.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now spotifyremote-radio
systemctl --user restart spotifyremote-radio
echo "Helper installed and running. Log: journalctl --user -u spotifyremote-radio -f"
