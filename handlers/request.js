const { getOrCreateUser, isAdmin } = require('./common');
const { logAction } = require('../logger');
const Request = require('../models/request');
const User = require('../models/user');

/**
 * Handle /requests command - list all requests for admins
 */
const handleListRequests = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    // Check if user is admin
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Get page parameter (if exists)
    const args = ctx.message.text.split(' ');
    const page = parseInt(args[1]) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    
    // Get requests count by status
    const pendingCount = await Request.countDocuments({ status: 'pending' });
    const approvedCount = await Request.countDocuments({ status: 'approved' });
    const assignedCount = await Request.countDocuments({ status: 'assigned' });
    const answeredCount = await Request.countDocuments({ status: 'answered' });
    const closedCount = await Request.countDocuments({ status: 'closed' });
    const declinedCount = await Request.countDocuments({ status: 'declined' });
    const totalCount = await Request.countDocuments();
    
    // Get requests for current page
    const requests = await Request.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId')
      .populate('categoryId')
      .populate('studentId');
    
    let message = `📊 Статистика обращений:\n`;
    message += `⏳ На рассмотрении: ${pendingCount}\n`;
    message += `👨‍💼 Ожидают исполнителя: ${approvedCount}\n`;
    message += `🔄 В обработке: ${assignedCount}\n`;
    message += `✅ На проверке: ${answeredCount}\n`;
    message += `✅ Закрыто: ${closedCount}\n`;
    message += `❌ Отклонено: ${declinedCount}\n`;
    message += `Всего: ${totalCount}\n\n`;
    
    message += `📋 Список обращений (страница ${page}):\n\n`;
    
    if (requests.length === 0) {
      message += 'Нет обращений для отображения.';
    } else {
      requests.forEach((request, index) => {
        const statusMap = {
          'pending': '⏳ На рассмотрении',
          'approved': '👨‍💼 Ожидает исполнителя',
          'declined': '❌ Отклонено',
          'assigned': '🔄 В обработке',
          'answered': '✅ Ответ на проверке',
          'closed': '✅ Закрыто'
        };
        
        const date = request.createdAt.toLocaleDateString('ru-RU');
        const username = request.userId.username 
          ? `@${request.userId.username}` 
          : `${request.userId.telegramId}`;
        
        message += `${skip + index + 1}. #${request._id} - ${statusMap[request.status]}\n`;
        message += `   Пользователь: ${username}\n`;
        message += `   Категория: ${request.categoryId.name} ${request.categoryId.hashtag}\n`;
        message += `   Дата: ${date}\n`;
        
        if (request.studentId) {
          const studentName = request.studentId.username 
            ? `@${request.studentId.username}` 
            : `${request.studentId.telegramId}`;
          
          message += `   Студент: ${studentName}\n`;
        }
        
        message += '\n';
      });
      
      // Add pagination info
      const totalPages = Math.ceil(totalCount / limit);
      message += `Страница ${page} из ${totalPages}. Используйте /requests <номер_страницы> для навигации.`;
    }
    
    await ctx.reply(message);
    await logAction('admin_listed_requests', { userId: user._id });
  } catch (error) {
    console.error('Error handling list requests:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /stats command - show bot statistics
 */
const handleStats = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    // Check if user is admin
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Get counts
    const usersCount = await User.countDocuments();
    const adminCount = await User.countDocuments({ role: 'admin' });
    const studentCount = await User.countDocuments({ role: 'student' });
    const userCount = await User.countDocuments({ role: 'user' });
    
    const totalRequests = await Request.countDocuments();
    const pendingCount = await Request.countDocuments({ status: 'pending' });
    const approvedCount = await Request.countDocuments({ status: 'approved' });
    const assignedCount = await Request.countDocuments({ status: 'assigned' });
    const answeredCount = await Request.countDocuments({ status: 'answered' });
    const closedCount = await Request.countDocuments({ status: 'closed' });
    const declinedCount = await Request.countDocuments({ status: 'declined' });
    
    let message = `📊 Статистика бота:\n\n`;
    
    message += `👥 Пользователи:\n`;
    message += `   Всего: ${usersCount}\n`;
    message += `   Администраторы: ${adminCount}\n`;
    message += `   Студенты: ${studentCount}\n`;
    message += `   Обычные пользователи: ${userCount}\n\n`;
    
    message += `📨 Обращения:\n`;
    message += `   Всего: ${totalRequests}\n`;
    message += `   ⏳ На рассмотрении: ${pendingCount}\n`;
    message += `   👨‍💼 Ожидают исполнителя: ${approvedCount}\n`;
    message += `   🔄 В обработке: ${assignedCount}\n`;
    message += `   ✅ На проверке: ${answeredCount}\n`;
    message += `   ✅ Закрыто: ${closedCount}\n`;
    message += `   ❌ Отклонено: ${declinedCount}\n`;
    
    await ctx.reply(message);
    await logAction('admin_viewed_stats', { userId: user._id });
  } catch (error) {
    console.error('Error handling stats command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

module.exports = {
  handleListRequests,
  handleStats
};