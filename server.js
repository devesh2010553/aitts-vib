require('dotenv').config();
const REQUIRED = ['MONGODB_URI','ADMIN_EMAIL','ADMIN_PASSWORD'];
const missing  = REQUIRED.filter(k=>!process.env[k]);
if (missing.length) { console.error('[STARTUP] Missing env vars:', missing.join(', ')); process.exit(1); }
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error('[STARTUP] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var');
  process.exit(1);
}
if (!process.env.JWT_SECRET) { process.env.JWT_SECRET = require('crypto').randomBytes(64).toString('hex'); console.warn('[STARTUP] JWT_SECRET not set -- add to Render env!'); }

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const mongoose     = require('mongoose');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');
const rateLimit    = require('express-rate-limit');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:process.env.CLIENT_URL||'*', credentials:true } });
app.set('io', io);

app.use((req,res,next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-XSS-Protection','1; mode=block'); next(); });
app.use(cors({ origin:process.env.CLIENT_URL||true, credentials:true }));
app.use(express.json({ limit:'20mb' }));
app.use(express.urlencoded({ extended:true, limit:'20mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:600 }));
app.use('/api/auth/register',        rateLimit({ windowMs:60*60*1000, max:10 }));

app.use(express.static(path.join(__dirname,'frontend'), {
  index: false,   // Do NOT serve index.html automatically — catch-all handles it with Firebase injection
  setHeaders:(res,fp) => {
    if (fp.endsWith('sw.js'))  { res.setHeader('Cache-Control','no-cache'); res.setHeader('Service-Worker-Allowed','/'); }
    if (fp.endsWith('.html'))    res.setHeader('Cache-Control','no-cache,no-store,must-revalidate');
  }
}));

app.get('/ping',   (_,res) => res.status(200).json({ status:'ok', ts:Date.now() }));
app.get('/health', (_,res) => res.json({ status:'ok', uptime:process.uptime() }));
app.get('/favicon.ico', (_,res) => res.status(204).end());
// Debug route — visit /api/debug-firebase to confirm env vars are set
app.get('/api/debug-firebase', (_,res) => {
  res.json({
    FIREBASE_API_KEY:            process.env.FIREBASE_API_KEY             ? 'SET ('+process.env.FIREBASE_API_KEY.slice(0,8)+'...)' : 'MISSING',
    FIREBASE_AUTH_DOMAIN:        process.env.FIREBASE_AUTH_DOMAIN         ? 'SET' : 'MISSING',
    FIREBASE_PROJECT_ID:         process.env.FIREBASE_PROJECT_ID          ? 'SET' : 'MISSING',
    FIREBASE_STORAGE_BUCKET:     process.env.FIREBASE_STORAGE_BUCKET      ? 'SET' : 'MISSING',
    FIREBASE_MESSAGING_SENDER_ID:process.env.FIREBASE_MESSAGING_SENDER_ID ? 'SET' : 'MISSING',
    FIREBASE_APP_ID:             process.env.FIREBASE_APP_ID              ? 'SET' : 'MISSING',
    FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON? 'SET' : 'MISSING',
  });
});
app.get('/robots.txt', (_,res) => { res.type('text/plain'); res.send('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://aiits-msc.onrender.com/sitemap.xml'); });
app.get('/sitemap.xml', (_,res) => {
  const base='https://aiits-msc.onrender.com', d=new Date().toISOString().split('T')[0];
  res.type('application/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+base+'/</loc><lastmod>'+d+'</lastmod><priority>1.0</priority></url><url><loc>'+base+'/register</loc><priority>0.8</priority></url><url><loc>'+base+'/login</loc><priority>0.7</priority></url></urlset>');
});

app.get('/adminvibacdonlineaiits', (_,res) => res.sendFile(path.join(__dirname,'frontend','adminvibacdonlineaiits.html')));
app.get('/ad856eyqafggg',           (_,res) => res.sendFile(path.join(__dirname,'frontend','ad856eyqafggg.html')));

app.use('/api/auth',     require('./backend/routes/auth'));
app.use('/api/admin',    require('./backend/routes/admin'));
app.use('/api/tests',    require('./backend/routes/tests'));
app.use('/api/results',  require('./backend/routes/results'));
app.use('/api/rankings', require('./backend/routes/rankings'));
app.use('/api/leaderboard', require('./backend/routes/leaderboard'));
app.use('/api/chat',        require('./backend/routes/chat'));
app.use('/api/push',     require('./backend/routes/push'));

app.get('/api/public/ad-images', async (req,res) => {
  try {
    const AdImage = require('./backend/models/AdImage');
    res.json(await AdImage.find({ showOnHome:true }).select('imageData title redirectUrl description').sort({ createdAt:-1 }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get('*', async (req,res) => {
  if (path.extname(req.path)&&path.extname(req.path)!=='.html') return res.status(404).json({ error:'Not found' });
  const firebaseConfig = {
    apiKey:            process.env.FIREBASE_API_KEY             || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN         || '',
    projectId:         process.env.FIREBASE_PROJECT_ID          || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET      || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID              || '',
  };
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname,'frontend','index.html'),'utf8');
  // Inject Firebase as regular (non-module) scripts so they run before onload
  const fbCfg = JSON.stringify(firebaseConfig);
  // Replace placeholder with compat SDK scripts + inline config
  // Using compat build so firebase.auth() works without ES module import
  // Use locally served Firebase files — no CDN, no network wait, always available
  const firebaseScripts =
    '<script src="/js/firebase-app-compat.js"></script>' +
    '<script src="/js/firebase-auth-compat.js"></script>' +
    '<script>try{var __fbApp=firebase.initializeApp(' + fbCfg + ');window._firebaseAuth=firebase.auth(__fbApp);}catch(e){console.error("Firebase init failed:",e);}</script>';
  html = html.replace('<script type="module">/* FIREBASE_CONFIG_PLACEHOLDER */</script>', firebaseScripts);
  res.setHeader('Content-Type','text/html');
  res.send(html);
});

// In-memory chat state (persists until server restart)
let chatMuted   = false;
const blockedUids = new Set(); // blocked student UIDs

app.set('io', io);
app.set('chatMuted', false);

io.on('connection', socket => {
  // Send current mute state on connect
  socket.emit('chat-mute-changed', { muted: chatMuted });
  socket.on('join-test',  id => socket.join('test-'+id));
  socket.on('leave-test', id => socket.leave('test-'+id));
  socket.on('join-admin', ()  => socket.join('admin-room'));

  // Verify admin from socket cookie
  function isAdminSocket() {
    try {
      const cookies = socket.handshake.headers.cookie || '';
      const match = cookies.match(/adminToken=([^;]+)/);
      if (!match) return false;
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(match[1], process.env.JWT_SECRET);
      return decoded.role === 'admin';
    } catch(e) { return false; }
  }

  // Public chat
  socket.on('chat-message', async (data) => {
    const adminSender = data.isAdmin && isAdminSocket();
    // Block if: global mute (non-admin) OR sender is individually blocked
    if (chatMuted && !adminSender) return;
    const uid = (data.uid || '').slice(0, 64);
    if (blockedUids.has(uid) && !adminSender) return;
    const msg = {
      name:    adminSender ? 'Admin' : (data.name || 'Student').slice(0, 40),
      uid:     adminSender ? '' : uid,
      batch:   adminSender ? '' : (data.batch || '').slice(0, 20),
      text:    (data.text || '').slice(0, 300),
      isAdmin: adminSender,
      time:    new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    };
    try {
      const ChatMessage = require('./backend/models/ChatMessage');
      const saved = await ChatMessage.create(msg);
      io.emit('chat-message', { ...msg, _id: saved._id, id: saved._id });
    } catch(e) {
      console.error('[CHAT] save failed:', e.message);
      io.emit('chat-message', { ...msg, id: Date.now() + Math.random().toString(36).slice(2) });
    }
  });

  // Admin mute/unmute all (also broadcast so clients persist it)
  socket.on('admin-toggle-mute', () => {
    if (!isAdminSocket()) return;
    chatMuted = !chatMuted;
    app.set('chatMuted', chatMuted);
    io.emit('chat-mute-changed', { muted: chatMuted });
  });

  // Admin block/unblock individual student
  socket.on('admin-block-student', (data) => {
    if (!isAdminSocket()) return;
    const uid = (data.uid || '').slice(0, 64);
    const name = (data.name || '').slice(0, 40);
    if (data.blocked) {
      blockedUids.add(uid);
    } else {
      blockedUids.delete(uid);
    }
    // Notify all clients to hide/show this student messages
    io.emit('student-blocked', { uid, name, blocked: !!data.blocked });
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',() => console.log('[SERVER] AIITS on port',PORT));
mongoose.connect(process.env.MONGODB_URI,{ serverSelectionTimeoutMS:15000 })
  .then(()=>console.log('[DB] MongoDB connected'))
  .catch(err=>console.error('[DB] MongoDB error:',err.message));
require('./backend/config/chatDb'); // second connection, dedicated to chat storage (MONGODB_URI2)
module.exports = { app, io };
