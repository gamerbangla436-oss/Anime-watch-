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

// Return series list (new model)
app.get('/anime', (req, res) => {
  res.json(readData());
});

// Legacy POST endpoint (keeps backwards compatibility): add a flat item as a new series with one episode
app.post('/anime', (req, res) => {
  const body = req.body;
  if (!body || !body.title) {
    return res.status(400).json({ success: false, error: 'missing title' });
  }

  const data = readData();
  // create a new series containing this as single-episode series
  const id = (body.id || body.title).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const series = {
    id,
    title: body.title,
    description: body.description || '',
    thumbnail: body.thumbnail || `https://via.placeholder.com/320x180?text=${encodeURIComponent(body.title)}`,
    episodes: [ { id: 's1', title: body.title, video: body.video || '' } ]
  };
  data.push(series);
  writeData(data);
  notifyAll(data);
  res.json({ success: true, series });
});

// Create a new series
app.post('/series', (req, res) => {
  const body = req.body;
  if (!body || !body.title) return res.status(400).json({ success: false, error: 'missing title' });

  const data = readData();
  const id = (body.id || body.title).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (data.find(s => s.id === id)) return res.status(409).json({ success: false, error: 'series id already exists' });

  const series = {
    id,
    title: body.title,
    description: body.description || '',
    thumbnail: body.thumbnail || `https://via.placeholder.com/320x180?text=${encodeURIComponent(body.title)}`,
    episodes: Array.isArray(body.episodes) ? body.episodes : []
  };

  data.push(series);
  writeData(data);
  notifyAll(data);
  res.json({ success: true, series });
});

// Add episode to existing series
app.post('/series/:id/episodes', (req, res) => {
  const sid = req.params.id;
  const body = req.body;
  if (!body || !body.title || !body.video) return res.status(400).json({ success: false, error: 'missing title or video' });

  const data = readData();
  const series = data.find(s => s.id === sid);
  if (!series) return res.status(404).json({ success: false, error: 'series not found' });

  // create episode id
  const eid = `e${(series.episodes.length + 1)}`;
  const episode = { id: eid, title: body.title, video: body.video };
  series.episodes.push(episode);
  writeData(data);
  notifyAll(data);
  res.json({ success: true, episode });
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
