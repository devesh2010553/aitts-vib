const mongoose = require('mongoose');
// userId used to be a Mongo ObjectId ref to the old User model; the user
// profile now lives on DynamoDB and userId is the Firebase uid string —
// ObjectId here would CastError on every subscribe.
const schema = new mongoose.Schema({ userId:{type:String}, endpoint:{type:String,required:true,unique:true}, keys:{p256dh:String,auth:String} }, { timestamps:true });
module.exports = mongoose.model('PushSubscription', schema);
