const ChatState = require('../models/ChatState');

async function getState() {
  const doc = await ChatState.findOneAndUpdate(
    { _id: 'singleton' },
    { $setOnInsert: { muted: false, blockedUids: [] } },
    { upsert: true, new: true }
  ).lean();
  return { muted: !!doc.muted, blockedUids: doc.blockedUids || [] };
}

async function isMuted() {
  const s = await getState();
  return s.muted;
}

async function isBlocked(uid) {
  if (!uid) return false;
  const s = await getState();
  return s.blockedUids.includes(uid);
}

async function toggleMute() {
  const s = await getState();
  const updated = await ChatState.findOneAndUpdate(
    { _id: 'singleton' }, { muted: !s.muted }, { upsert: true, new: true }
  ).lean();
  return updated.muted;
}

async function setBlocked(uid, blocked) {
  const update = blocked ? { $addToSet: { blockedUids: uid } } : { $pull: { blockedUids: uid } };
  await ChatState.findOneAndUpdate({ _id: 'singleton' }, update, { upsert: true });
}

module.exports = { getState, isMuted, isBlocked, toggleMute, setBlocked };
