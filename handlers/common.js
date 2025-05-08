const { Markup } = require('telegraf');
const User = require('../models/user');
const { logAction } = require('../logger');

/**
 * Create or update user in database
 * @param {Object} ctx - Telegram context
 * @returns {Promise<Object>} - User object
 */
const getOrCreateUser = async (ctx) => {
  const telegramUser = ctx.from;
  
  try {
    let user = await User.findOne({ telegramId: telegramUser.id });
    
    if (!user) {
      user = new User({
        telegramId: telegramUser.id,
        firstName: telegramUser.first_name,
        lastName: telegramUser.last_name,
        username: telegramUser.username
      });
      
      await user.save();
      await logAction('user_registered', { userId: user._id });
    }
    
    return user;
  } catch (error) {
    console.error('Error getting or creating user:', error);
    throw error;
  }
};

/**
 * Get main menu keyboard
 * @returns {Object} - Keyboard markup
 */
const getMainMenuKeyboard = () => {
  return Markup.keyboard([
    ['Задать вопрос'],
    ['FAQ'],
    ['Мои обращения']
  ]).resize();
};

/**
 * Back button keyboard
 * @returns {Object} - Keyboard markup
 */
const getBackKeyboard = (text = 'Назад') => {
  return Markup.keyboard([[text]]).resize();
};

/**
 * Check if user is admin
 * @param {Object} user - User object
 * @returns {Boolean} - Is admin
 */
const isAdmin = (user) => {
  return user.role === 'admin';
};

/**
 * Check if user is student
 * @param {Object} user - User object
 * @returns {Boolean} - Is student
 */
const isStudent = (user) => {
  return user.role === 'student';
};

module.exports = {
  getOrCreateUser,
  getMainMenuKeyboard,
  getBackKeyboard,
  isAdmin,
  isStudent
};