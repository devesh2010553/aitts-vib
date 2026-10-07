const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const userSchema = new mongoose.Schema({
  name:             { type:String, required:true, trim:true },
  email:            { type:String, required:true, unique:true, lowercase:true, trim:true },
  phone:            { type:String, required:true, unique:true, trim:true },
  password:         { type:String, required:true },
  coachingName:     { type:String, required:true, trim:true },
  fatherName:       { type:String, required:true, trim:true },
  fatherOccupation: { type:String, required:true, trim:true },
  whatsappNumber:   { type:String, required:true, trim:true },
  batch:            { type:String, enum:['11','12','dropper'], required:true },
  otp:              { type:String },
  otpExpiry:        { type:Date },
  totalTests:       { type:Number, default:0 },
  totalMarks:       { type:Number, default:0 },
  highestMarks:     { type:Number, default:0 },
  lastLogin:        { type:Date }
}, { timestamps:true });
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10); next();
});
userSchema.methods.comparePassword = function(plain) { return bcrypt.compare(plain, this.password); };
module.exports = mongoose.model('User', userSchema);
