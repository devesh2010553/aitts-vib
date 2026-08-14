/**
 * routes/chat.js
 * Public chat, mute controlled by admin — moderation state lives in MongoDB
 * (ChatState), not process memory, so it's correct across restarts and safe
 * if the app ever runs multiple Node.js workers (see backend/utils/chatState.js).
 * Messages are persisted to a SECOND MongoDB (MONGODB_URI2) via ChatMessage,
 * and are never auto-deleted — only an admin can remove them.
 */
const express      = require('express');
const router       = express.Router();
const ChatMessage  = require('../models/ChatMessage');
const { authenticateAdmin } = require('../middleware/auth');
const { isMuted, toggleMute } = require('../utils/chatState');

// GET chat status (public) - clients call on page load to restore mute state
router.get('/status', async (req, res) => {
  try { res.json({ muted: await isMuted() }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// GET chat history (public) — most recent messages, oldest first
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 300, 500);
    const msgs = await ChatMessage.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json(msgs.reverse());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST toggle mute — admin only
router.post('/mute', authenticateAdmin, async (req, res) => {
  try {
    const next = await toggleMute();
    const io = req.app.get('io');
    if (io) io.emit('chat-mute-changed', { muted: next });
    res.json({ muted: next });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE a single message — admin only
router.delete('/messages/:id', authenticateAdmin, async (req, res) => {
  try {
    await ChatMessage.findByIdAndDelete(req.params.id);
    const io = req.app.get('io');
    if (io) io.emit('chat-message-deleted', { id: req.params.id });
    res.json({ message: 'Deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE all messages — admin only
router.delete('/messages', authenticateAdmin, async (req, res) => {
  try {
    const r = await ChatMessage.deleteMany({});
    const io = req.app.get('io');
    if (io) io.emit('chat-cleared');
    res.json({ message: 'Chat cleared', deleted: r.deletedCount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
