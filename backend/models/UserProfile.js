const mongoose = require('mongoose');

const userProfileSchema = new mongoose.Schema({
  uid:              { type: String, required: true, unique: true, index: true },
  name:             { type: String, required: true, trim: true },
  phone:            { type: String, required: true, unique: true, trim: true },
  coachingName:     { type: String, required: true, trim: true },
  fatherName:       { type: String, required: true, trim: true },
  fatherOccupation: { type: String, required: true, trim: true },
  whatsappNumber:   { type: String, required: true, trim: true },
  batch:            { type: String, enum: ['11', '12', 'dropper'], required: true },
  totalTests:       { type: Number, default: 0 },
  totalMarks:       { type: Number, default: 0 },
  highestMarks:     { type: Number, default: 0 },
}, { timestamps: true });
// Supports GET /api/rankings/top-performers (homepage, public, hit often) and
// GET /api/rankings/leaderboard: both filter { totalTests: { $gt: 0 } } and
// sort by totalMarks descending. Without this, that's a collection scan +
// in-memory sort once the student base grows past a few thousand.
userProfileSchema.index({ totalTests: 1, totalMarks: -1 });

module.exports = mongoose.model('UserProfile', userProfileSchema);
