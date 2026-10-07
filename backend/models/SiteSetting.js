const chatDb = require('../config/chatDb');
const { Schema } = require('mongoose');

// Generic key/value store for small pieces of site content that don't
// deserve their own collection — e.g. the Search Console screenshot URL
// shown on the private "about the builder" page. Lives on the secondary
// connection (MONGODB_URI2) alongside AdImage/ChatMessage: this is site
// content, not exam data, so it has no reason to sit on the primary
// cluster the concurrent-exam-load work in this repo is tuned around.
const siteSettingSchema = new Schema({
  _id:   { type: String, required: true }, // the setting's key, e.g. 'searchConsoleImageUrl'
  value: { type: String, default: '' },
}, { timestamps: true });

module.exports = chatDb.model('SiteSetting', siteSettingSchema);
