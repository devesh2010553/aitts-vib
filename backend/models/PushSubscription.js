const mongoose = require('mongoose');
// userId is a plain String (Firebase uid) now, not an ObjectId ref — see
// the same note in CheatingLog.js.
const schema = new mongoose.Schema({ userId:{type:String}, endpoint:{type:String,required:true,unique:true}, keys:{p256dh:String,auth:String} }, { timestamps:true });
module.exports = mongoose.model('PushSubscription', schema);
