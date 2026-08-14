const mongoose = require('mongoose');
const optionSchema = new mongoose.Schema({ text:{type:String,required:true}, isCorrect:{type:Boolean,default:false}, imageData:{type:String,default:''} });
const questionSchema = new mongoose.Schema({ questionText:{type:String,default:''}, questionImage:{type:String,default:''}, options:[optionSchema], isMultiChoice:{type:Boolean,default:false}, correctOptions:[{type:Number}], marks:{type:Number,default:4}, negativeMarks:{type:Number,default:1}, explanation:{type:String,default:''} });
const testSchema = new mongoose.Schema({
  title:{type:String,required:true,trim:true}, subject:{type:String,required:true,trim:true},
  topic:{type:String,required:true,trim:true}, description:{type:String,default:''},
  duration:{type:Number,required:true}, totalMarks:{type:Number},
  questions:[questionSchema], isActive:{type:Boolean,default:true},
  isPublished:{type:Boolean,default:false}, startTime:{type:Date}, endTime:{type:Date},
  adEnabled:{type:Boolean,default:false}, adImages:[{type:mongoose.Schema.Types.ObjectId,ref:'AdImage'}],
  adRedirectUrl:{type:String,default:''}, adHtml:{type:String,default:''},
  attemptCount:{type:Number,default:0}, targetBatches:[{type:String,enum:['11','12','dropper']}],
  bonusMarks:{type:Number,default:0}
}, { timestamps:true });
testSchema.pre('save', function(next) {
  if (this.questions&&this.questions.length) this.totalMarks = this.questions.reduce((s,q)=>s+q.marks,0);
  next();
});
module.exports = mongoose.model('Test', testSchema);
