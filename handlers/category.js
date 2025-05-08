const { getOrCreateUser, isAdmin } = require('./common');
const { logAction } = require('../logger');
const Category = require('../models/category');

/**
 * Handle /categories command - list all categories
 */
const handleListCategories = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    // Check if user is admin
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    let message = '📋 Список категорий:\n\n';
    
    categories.forEach((category, index) => {
      message += `${index + 1}. ${category.name} (${category.hashtag})\n`;
    });
    
    await ctx.reply(message);
    await logAction('admin_listed_categories', { userId: user._id });
  } catch (error) {
    console.error('Error handling list categories:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

module.exports = {
  handleListCategories
};