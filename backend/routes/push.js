const express          = require('express');
const router           = express.Router();
const webpush          = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const CheatingLog      = require('../models/CheatingLog');
const { authenticateStudent, authenticateAdmin } = require('../middleware/auth');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:'+(process.env.ADMIN_EMAIL||'admin@aiits.com'), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

router.get('/vapid-public-key', (req,res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY||'' }));

router.post('/subscribe', authenticateStudent, async (req,res) => {
  try {
    const { subscription } = req.body;
    if (!subscription||!subscription.endpoint) return res.status(400).json({ error:'Invalid subscription' });
    await PushSubscription.findOneAndUpdate({ endpoint:subscription.endpoint }, { endpoint:subscription.endpoint, keys:subscription.keys, userId:req.user._id }, { upsert:true, new:true });
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.post('/announce', authenticateAdmin, async (req,res) => {
  try {
    const { title, body, url } = req.body;
    if (!title||!body) return res.status(400).json({ error:'Title and body required' });
    if (!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY) return res.status(400).json({ error:'VAPID keys not set in Render env vars.' });
    const subs = await PushSubscription.find();
    const payload = JSON.stringify({ title, body, url:url||'/', icon:'/images/icon-192.png', badge:'/images/icon-192.png' });
    let sent=0, failed=0;
    for (const sub of subs) {
      try { await webpush.sendNotification({ endpoint:sub.endpoint, keys:sub.keys }, payload); sent++; }
      catch(e) { failed++; if (e.statusCode===410||e.statusCode===404) await PushSubscription.deleteOne({ _id:sub._id }).catch(()=>{}); }
    }
    res.json({ sent, failed, total:subs.length });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.post('/cheat-log', authenticateStudent, async (req,res) => {
  try {
    const { testId, testTitle, violations, autoSubmitted, details } = req.body;
    await CheatingLog.create({ userId:req.user._id, userName:req.user.name, userEmail:req.user.email, testId, testTitle, violations:violations||1, autoSubmitted:!!autoSubmitted, details });
    const io = req.app.get('io');
    if (io) io.to('admin-room').emit('cheat-alert', { name:req.user.name, email:req.user.email, violations, autoSubmitted, testTitle });
    res.json({ logged:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/cheat-logs', authenticateAdmin, async (req,res) => {
  try { res.json(await CheatingLog.find().sort({ createdAt:-1 }).limit(500)); }
  catch(err) { res.status(500).json({ error:err.message }); }
});



router.delete('/cheat-logs', authenticateAdmin, async (req,res) => {
  try {
    const { id } = req.query;
    if (id) {
      await CheatingLog.findByIdAndDelete(id);
      res.json({ message: 'Log deleted' });
    } else {
      const r = await CheatingLog.deleteMany({});
      res.json({ message: 'All cheat logs cleared', deleted: r.deletedCount });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});
module.exports = router;
