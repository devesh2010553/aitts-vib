const mongoose = require('mongoose');
// userId/testId used to be Mongo ObjectId refs; both Test and the user
// profile now live on DynamoDB and are plain string ids (e.g. "test_<uuid>",
// a Firebase uid) — kept as ObjectId here would throw a CastError on every
// create()/find() (silently swallowed by the .catch()s in routes/push.js),
// so cheat logs were never actually being written.
const schema = new mongoose.Schema({ userId:{type:String}, userName:{type:String}, userEmail:{type:String}, testId:{type:String}, testTitle:{type:String}, violations:{type:Number,default:0}, autoSubmitted:{type:Boolean,default:false}, details:{type:String} }, { timestamps:true });
module.exports = mongoose.model('CheatingLog', schema);
