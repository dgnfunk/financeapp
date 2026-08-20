#!/bin/sh
set -eu

tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status

