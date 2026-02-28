# WAN Emulator Control Panel

A Docker-based web app for configuring `tc qdisc` (traffic control) settings on
one or more Linux WAN emulator hosts over SSH.

## Features

- Connect to 1–6 WAN emulator hosts via SSH (username/password)
- Auto-discovers all network interfaces and their IP addresses
- Per-interface control of:
  - **Loss** (0–100%)
  - **Latency** (0–2000 ms)
  - **Jitter** (0–500 ms)
  - **Bandwidth** (kbps, 0 = unlimited)
- Hide interfaces you don't need
- Custom labels per interface
- Apply/clear settings independently per interface
- Reads existing `tc` settings on connect

## Prerequisites on WAN Emulator Hosts

Each Ubuntu/Debian host must have `iproute2` installed and the SSH user must be
able to run `sudo tc` without a password prompt.

```bash
# Install iproute2 (usually pre-installed on Ubuntu)
sudo apt-get install -y iproute2

# Allow the SSH user to run tc without password
# Add to /etc/sudoers.d/tc-nopasswd:
echo "your_username ALL=(ALL) NOPASSWD: /sbin/tc" | sudo tee /etc/sudoers.d/tc-nopasswd
sudo chmod 440 /etc/sudoers.d/tc-nopasswd
```

## Running

### With Docker Compose (recommended)

```bash
docker compose up -d
```

Then open http://localhost:3000 in your browser.

### With Docker directly

```bash
docker build -t wan-control .
docker run -d -p 3000:3000 --name wan-control wan-control
```

### For development (no Docker)

```bash
cd backend
npm install
node server.js
```

## Usage

1. Open http://localhost:3000
2. Select the number of WAN emulator hosts
3. Enter the hostname/IP, SSH port, username, and password for each
4. Click **Connect & Load Interfaces**
5. The dashboard shows all interfaces for each host
6. Adjust sliders or type values for Loss, Latency, Jitter, and Bandwidth
7. Click **▶ Apply** to push the `tc` commands, or **✕ Clear** to remove them
8. Click **⊘ Hide** to hide interfaces you don't want to control
9. Click the interface label area to add a custom name

## How tc Commands Work

When you click Apply, the backend generates and runs commands like:

**Bandwidth + Latency/Loss/Jitter** (chains tbf → netem):
```bash
tc qdisc del dev eth0 root
tc qdisc add dev eth0 root handle 1: tbf rate 10000kbit burst 125000 latency 50ms
tc qdisc add dev eth0 parent 1: handle 10: netem delay 50ms 10ms distribution normal loss 1%
```

**Latency/Loss/Jitter only** (netem):
```bash
tc qdisc del dev eth0 root
tc qdisc add dev eth0 root netem delay 100ms 20ms distribution normal loss 0.5%
```

**Bandwidth only** (tbf):
```bash
tc qdisc del dev eth0 root
tc qdisc add dev eth0 root tbf rate 5000kbit burst 62500 latency 50ms
```

## Security Note

Credentials are held in memory in the Node.js backend for the session duration.
This app is intended for **lab/internal network use only**. Do not expose it to
the internet.
