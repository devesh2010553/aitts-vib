/**
 * routes/chat.js
 * Public chat, mute controlled by admin (in-memory, see server.js).
 * Messages are persisted to a SECOND MongoDB (MONGODB_URI2) via ChatMessage,
 * and are never auto-deleted — only an admin can remove them.
 */
const express      = require('express');
const router       = express.Router();
const ChatMessage  = require('../models/ChatMessage');
const { authenticateAdmin } = require('../middleware/auth');

// GET chat status (public) - clients call on page load to restore mute state
router.get('/status', (req, res) => {
  res.json({ muted: req.app.get('chatMuted') || false });
});

// GET chat history (public) — most recent messages, oldest first
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 300, 500);
    const msgs = await ChatMessage.find().sort({ createdAt: -1 }).limit(limit);
    res.json(msgs.reverse());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST toggle mute — admin only
router.post('/mute', authenticateAdmin, (req, res) => {
  const current = req.app.get('chatMuted') || false;
  const next = !current;
  req.app.set('chatMuted', next);
  const io = req.app.get('io');
  if (io) io.emit('chat-mute-changed', { muted: next });
  res.json({ muted: next });
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
