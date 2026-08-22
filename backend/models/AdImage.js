const chatDb = require('../config/chatDb');
const { Schema } = require('mongoose');
// Moved to the MONGODB_URI2 connection — ad images (base64) were adding
// meaningful storage weight to the main database; this keeps them (and PDF
// import jobs, see PdfImportJob.js) on the secondary cluster instead.
// NOTE: because this is a different connection than Test lives on,
// Test.adImages' ref-based populate can't auto-resolve this model — see the
// explicit `model:` override in routes/tests.js's GET /:id/ad route.
const adImageSchema = new Schema({ title:{type:String,default:''}, description:{type:String,default:''}, imageData:{type:String,required:true}, redirectUrl:{type:String,default:''}, showOnHome:{type:Boolean,default:true} }, { timestamps:true });
module.exports = chatDb.model('AdImage', adImageSchema);
