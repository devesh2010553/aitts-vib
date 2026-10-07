const mongoose = require('mongoose');
// userId/testId are plain Strings, not ObjectId refs, since the DynamoDB
// migration: userId is now a Firebase uid ("abc123...") and testId is a
// DynamoDB-generated id ("test_<uuid>") — neither is a valid Mongo
// ObjectId, so the old `type: mongoose.Schema.Types.ObjectId` here made
// every single .create() call throw a CastError (500) the moment either
// migration landed. This is exactly what was causing /api/push/cheat-log
// to 500 on every cheat-log submission.
const schema = new mongoose.Schema({ userId:{type:String}, userName:{type:String}, userEmail:{type:String}, testId:{type:String}, testTitle:{type:String}, violations:{type:Number,default:0}, autoSubmitted:{type:Boolean,default:false}, details:{type:String} }, { timestamps:true });
module.exports = mongoose.model('CheatingLog', schema);
