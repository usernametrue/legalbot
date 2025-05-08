const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  text: {
    type: String,
    required: true,
    minLength: 150
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined', 'assigned', 'answered', 'closed'],
    default: 'pending'
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  answerText: {
    type: String,
    default: null
  },
  adminComment: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Request', requestSchema);