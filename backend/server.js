const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, "data.json");

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf-8");
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    return [];
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// SSE clients
let clients = [];

function notifyAll(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => {
    try {
      c.res.write(payload);
    } catch (e) {
      // ignore individual client errors
    }
  });
}

// Serve frontend and admin static files
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.use('/admin', express.static(path.join(__dirname, "..", "admin")));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.get("/anime", (req, res) => {
  res.json(readData());
});

app.post("/anime", (req, res) => {
  const item = req.body;
  if (!item || !item.title) {
    return res.status(400).json({ success: false, error: 'missing title' });
  }

  const data = readData();
  data.push(item);
  writeData(data);

  // notify SSE clients with the full updated list
  notifyAll(data);

  res.json({ success: true });
});

// Server-Sent Events endpoint for live updates
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  // Send current full list once on connect
  const current = readData();
  res.write(`data: ${JSON.stringify(current)}\n\n`);

  const client = { id: Date.now() + Math.random(), res };
  clients.push(client);

  // remove client on close
  req.on('close', () => {
    clients = clients.filter(c => c !== client);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
