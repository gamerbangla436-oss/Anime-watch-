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

// Return full series list
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
  const id = (body.id || body.title).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const series = {
    id,
    title: body.title,
    description: body.description || '',
    thumbnail: body.thumbnail || `https://via.placeholder.com/320x180?text=${encodeURIComponent(body.title)}`,
    episodes: [ { id: 's1', title: body.title, video: body.video || '' } ],
    status: body.status || null,
    progress: body.progress || 0
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
    episodes: Array.isArray(body.episodes) ? body.episodes : [],
    anilistId: body.anilistId || null,
    malId: body.malId || null,
    featured: !!body.featured,
    status: body.status || null,
    progress: body.progress || 0
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

// Update series fields (partial update)
app.patch('/series/:id', (req, res) => {
  const sid = req.params.id;
  const body = req.body || {};
  const data = readData();
  const series = data.find(s => s.id === sid);
  if (!series) return res.status(404).json({ success: false, error: 'series not found' });

  // update allowed fields
  const allowed = ['title','description','thumbnail','anilistId','malId','featured','status','progress'];
  allowed.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(body, k)) series[k] = body[k];
  });

  writeData(data);
  notifyAll(data);
  res.json({ success: true, series });
});

// Watchlist endpoints (simple per-session JSON store)
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
if (!fs.existsSync(WATCHLIST_FILE)) fs.writeFileSync(WATCHLIST_FILE, '[]', 'utf-8');
function readWatchlist(){ try{return JSON.parse(fs.readFileSync(WATCHLIST_FILE,'utf-8')||'[]')}catch(e){return[];} }
function writeWatchlist(w){ fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(w,null,2)); }

app.get('/watchlist', (req,res)=>{ res.json(readWatchlist()); });
app.post('/watchlist', (req,res)=>{
  const item = req.body;
  if(!item || !item.seriesId || !item.episodeId) return res.status(400).json({success:false,error:'missing seriesId or episodeId'});
  const list = readWatchlist();
  list.push(item);
  writeWatchlist(list);
  notifyAll(readData());
  res.json({success:true});
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
