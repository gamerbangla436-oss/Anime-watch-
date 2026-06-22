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

// Enrich metadata from AniList (server-side)
async function fetchAniList(id){
  if(!id) return null;
  try{
    const query = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english native } description coverImage { large medium } bannerImage siteUrl episodes season seasonYear genres tags { name } trailer { id site } } }`;
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: Number(id) } })
    });
    if(!resp.ok) return null;
    const j = await resp.json();
    return j.data && j.data.Media ? j.data.Media : null;
  }catch(e){
    console.error('AniList fetch error', e);
    return null;
  }
}

// Enrich all series with anilistId
app.post('/enrich', async (req, res) => {
  const data = readData();
  for(const s of data){
    if(s.anilistId){
      const meta = await fetchAniList(s.anilistId);
      if(meta){
        s.description = s.description && s.description.length>10 ? s.description : (meta.description || s.description || '');
        s.thumbnail = meta.coverImage && (meta.coverImage.large || meta.coverImage.medium) ? (meta.coverImage.large || meta.coverImage.medium) : s.thumbnail;
        s.bannerImage = meta.bannerImage || s.bannerImage || null;
        if(meta.trailer && meta.trailer.site === 'youtube' && meta.trailer.id){
          s.trailer = `https://www.youtube.com/watch?v=${meta.trailer.id}`;
        } else if(meta.trailer && meta.trailer.site){
          s.trailer = null;
        }
        s.genres = meta.genres || s.genres || [];
        s.season = meta.season || s.season || null;
        s.seasonYear = meta.seasonYear || s.seasonYear || null;
        s.episodesCount = meta.episodes || s.episodesCount || (s.episodes ? s.episodes.length : 0);
      }
      // small delay to avoid rate limits
      await new Promise(r=>setTimeout(r, 300));
    }
  }
  writeData(data);
  notifyAll(data);
  res.json({ success: true, updated: data.length });
});

// Enrich single series
app.post('/enrich/:id', async (req, res) => {
  const sid = req.params.id;
  const data = readData();
  const series = data.find(s=>s.id===sid);
  if(!series) return res.status(404).json({ success:false, error:'series not found' });
  if(!series.anilistId) return res.status(400).json({ success:false, error:'no anilistId' });
  const meta = await fetchAniList(series.anilistId);
  if(meta){
    series.description = series.description && series.description.length>10 ? series.description : (meta.description || series.description || '');
    series.thumbnail = meta.coverImage && (meta.coverImage.large || meta.coverImage.medium) ? (meta.coverImage.large || meta.coverImage.medium) : series.thumbnail;
    series.bannerImage = meta.bannerImage || series.bannerImage || null;
    if(meta.trailer && meta.trailer.site === 'youtube' && meta.trailer.id){
      series.trailer = `https://www.youtube.com/watch?v=${meta.trailer.id}`;
    }
    series.genres = meta.genres || series.genres || [];
    series.season = meta.season || series.season || null;
    series.seasonYear = meta.seasonYear || series.seasonYear || null;
    series.episodesCount = meta.episodes || series.episodesCount || (series.episodes ? series.episodes.length : 0);
    writeData(data);
    notifyAll(data);
    return res.json({ success:true, series });
  }
  res.status(500).json({ success:false, error:'failed to fetch metadata' });
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
