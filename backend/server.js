const express = require('express');
const cors = require('cors');
const { Client } = require('ssh2');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('/app/frontend'));

// In-memory store of SSH connections
const connections = {};

// Helper: run a command over SSH
function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', (code) => {
        resolve({ stdout, stderr, code });
      });
    });
  });
}

// Connect to a host
app.post('/api/connect', async (req, res) => {
  const { id, host, port, username, password } = req.body;
  if (!id || !host || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Close existing connection if any
  if (connections[id]) {
    try { connections[id].end(); } catch(e) {}
    delete connections[id];
  }

  const conn = new Client();
  try {
    await new Promise((resolve, reject) => {
      conn.on('ready', resolve);
      conn.on('error', reject);
      conn.connect({
        host,
        port: port || 22,
        username,
        password,
        readyTimeout: 10000,
        keepaliveInterval: 30000
      });
    });
    connections[id] = conn;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Connection failed' });
  }
});

// Disconnect from a host
app.post('/api/disconnect', (req, res) => {
  const { id } = req.body;
  if (connections[id]) {
    try { connections[id].end(); } catch(e) {}
    delete connections[id];
  }
  res.json({ success: true });
});

// Get interfaces for a host
app.get('/api/interfaces/:id', async (req, res) => {
  const { id } = req.params;
  const conn = connections[id];
  if (!conn) return res.status(404).json({ error: 'Not connected' });

  try {
    // Get interface names, IPs, and current tc settings
    const { stdout: ifOut } = await sshExec(conn, 
      `ip -o addr show | awk '{print $2, $3, $4}' | grep -v '^lo '`
    );

    const ifaceMap = {};
    ifOut.trim().split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const name = parts[0];
        const family = parts[1]; // 'inet' or 'inet6'
        const addr = parts[2].split('/')[0];
        if (!ifaceMap[name]) ifaceMap[name] = { name, ipv4: [], ipv6: [] };
        if (family === 'inet') ifaceMap[name].ipv4.push(addr);
        else if (family === 'inet6') ifaceMap[name].ipv6.push(addr);
      }
    });

    // Get tc qdisc info for each interface
    const { stdout: tcOut } = await sshExec(conn, 
      `tc qdisc show 2>/dev/null || true`
    );

    const tcMap = parseTcQdisc(tcOut);

    const interfaces = Object.values(ifaceMap).map(iface => {
      const tc = tcMap[iface.name] || {};
      return {
        name: iface.name,
        ipv4: iface.ipv4.join(', '),
        ipv6: iface.ipv6.filter(a => !a.startsWith('fe80')).join(', '), // skip link-local
        loss: tc.loss || 0,
        latency: tc.latency || 0,
        jitter: tc.jitter || 0,
        bandwidth: tc.bandwidth || 0
      };
    });

    res.json({ interfaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseTcQdisc(output) {
  const map = {};
  const lines = output.trim().split('\n');
  for (const line of lines) {
    const devMatch = line.match(/dev (\S+)/);
    if (!devMatch) continue;
    const dev = devMatch[1];
    if (!map[dev]) map[dev] = {};

    // netem
    const latencyMatch = line.match(/delay (\d+(?:\.\d+)?)(\w+)/);
    if (latencyMatch) {
      let val = parseFloat(latencyMatch[1]);
      if (latencyMatch[2] === 'ms') map[dev].latency = val;
      else if (latencyMatch[2] === 'us') map[dev].latency = val / 1000;
      else map[dev].latency = val;
    }

    const jitterMatch = line.match(/delay \S+ (\d+(?:\.\d+)?)(\w+)/);
    if (jitterMatch) {
      let val = parseFloat(jitterMatch[1]);
      if (jitterMatch[2] === 'ms') map[dev].jitter = val;
      else if (jitterMatch[2] === 'us') map[dev].jitter = val / 1000;
      else map[dev].jitter = val;
    }

    const lossMatch = line.match(/loss (\d+(?:\.\d+)?)%/);
    if (lossMatch) map[dev].loss = parseFloat(lossMatch[1]);

    // tbf rate
    const rateMatch = line.match(/rate (\d+(?:\.\d+)?)(Kbit|Mbit|Gbit|bit)/);
    if (rateMatch) {
      let val = parseFloat(rateMatch[1]);
      const unit = rateMatch[2];
      if (unit === 'bit') val = val / 1000;
      else if (unit === 'Mbit') val = val * 1000;
      else if (unit === 'Gbit') val = val * 1000000;
      map[dev].bandwidth = Math.round(val);
    }
  }
  return map;
}

// Apply tc settings to an interface
app.post('/api/apply', async (req, res) => {
  const { id, iface, loss, latency, jitter, bandwidth } = req.body;
  const conn = connections[id];
  if (!conn) return res.status(404).json({ error: 'Not connected' });

  try {
    const cmds = buildTcCommands(iface, { loss, latency, jitter, bandwidth });
    const results = [];
    for (const cmd of cmds) {
      const result = await sshExec(conn, cmd);
      results.push({ cmd, ...result });
      if (result.code !== 0 && result.stderr && !result.stderr.includes('RTNETLINK') && !result.stderr.includes('No such')) {
        // non-fatal
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear tc settings on an interface
app.post('/api/clear', async (req, res) => {
  const { id, iface } = req.body;
  const conn = connections[id];
  if (!conn) return res.status(404).json({ error: 'Not connected' });

  try {
    await sshExec(conn, `sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
    await sshExec(conn, `sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildTcCommands(iface, { loss, latency, jitter, bandwidth }) {
  const cmds = [];
  
  // Remove existing qdiscs
  cmds.push(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
  
  const hasNetem = (latency > 0 || jitter > 0 || loss > 0);
  const hasTbf = bandwidth > 0;

  if (!hasNetem && !hasTbf) {
    // Nothing to set, just cleared
    return cmds;
  }

  if (hasTbf && hasNetem) {
    // Chain: tbf -> netem using HTB + netem
    // Use prio + netem approach: tbf at root, netem as child via handle
    // Simpler: use IFB or just HTB. Best approach for both: tbf root, netem as child
    const rate = `${bandwidth}kbit`;
    const burst = Math.max(Math.ceil(bandwidth * 1000 / 8 / 100), 1600); // ~10ms burst
    cmds.push(`sudo tc qdisc add dev ${iface} root handle 1: tbf rate ${rate} burst ${burst} latency 50ms`);
    let netemArgs = buildNetemArgs(loss, latency, jitter);
    cmds.push(`sudo tc qdisc add dev ${iface} parent 1: handle 10: netem ${netemArgs}`);
  } else if (hasTbf) {
    const rate = `${bandwidth}kbit`;
    const burst = Math.max(Math.ceil(bandwidth * 1000 / 8 / 100), 1600);
    cmds.push(`sudo tc qdisc add dev ${iface} root tbf rate ${rate} burst ${burst} latency 50ms`);
  } else if (hasNetem) {
    let netemArgs = buildNetemArgs(loss, latency, jitter);
    cmds.push(`sudo tc qdisc add dev ${iface} root netem ${netemArgs}`);
  }

  return cmds;
}

function buildNetemArgs(loss, latency, jitter) {
  let args = '';
  if (latency > 0 || jitter > 0) {
    args += `delay ${latency}ms`;
    if (jitter > 0) args += ` ${jitter}ms distribution normal`;
  }
  if (loss > 0) {
    args += ` loss ${loss}%`;
  }
  return args.trim();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WAN Emulator Controller running on port ${PORT}`));
