const mongoose = require('mongoose');
// Deliberately NOT on DynamoDB, same reasoning as CheatingLog/PushSubscription/
// ForgotAttempt/AdImage: this is low-volume metadata, and adding it here means
// no new AWS table has to be created by hand (see DYNAMODB_SETUP.md — every
// DynamoDB table in this app was a manual console step).
// _id IS the lowercased email itself — a natural key, and it makes the
// existence check a single GetItem-style findById instead of a query.
const schema = new mongoose.Schema({
  _id: { type: String }, // lowercased email
  deletedBy: { type: String, default: 'admin' },
  reason: { type: String, default: '' },
}, { timestamps: true });
module.exports = mongoose.model('DeletedAccount', schema);
