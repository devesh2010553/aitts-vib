const mongoose = require('mongoose');
const answerSchema = new mongoose.Schema({ questionId:{type:mongoose.Schema.Types.ObjectId}, selectedOption:{type:Number,default:-1}, selectedOptions:[{type:Number}], isCorrect:{type:Boolean,default:false}, marksAwarded:{type:Number,default:0} });
const resultSchema = new mongoose.Schema({
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  testId:{type:mongoose.Schema.Types.ObjectId,ref:'Test',required:true},
  userName:{type:String}, userEmail:{type:String}, coachingName:{type:String},
  batch:{type:String,enum:['11','12','dropper']},
  answers:[answerSchema], totalMarks:{type:Number,default:0}, obtainedMarks:{type:Number,default:0},
  correctAnswers:{type:Number,default:0}, wrongAnswers:{type:Number,default:0}, notAttempted:{type:Number,default:0},
  timeTaken:{type:Number,default:0}, rank:{type:Number}, batchRank:{type:Number},
  submittedAt:{type:Date,default:Date.now}, startedAt:{type:Date},
  inProgress:{type:Boolean,default:false}, savedAnswers:{type:mongoose.Schema.Types.Mixed,default:{}},
  lastActiveAt:{type:Date}, violations:{type:Number,default:0},
  bonusMarks:{type:Number,default:0}, testBonusApplied:{type:Number,default:0}
}, { timestamps:true });
resultSchema.index({ userId:1, testId:1 }, { unique:true });
resultSchema.index({ testId:1, batch:1, obtainedMarks:-1, timeTaken:1 });
module.exports = mongoose.model('Result', resultSchema);
