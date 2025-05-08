const { getOrCreateUser, getMainMenuKeyboard } = require('./common');
const { logAction } = require('../logger');

module.exports = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    const welcomeMessage = `
Добро пожаловать в бот юридической клиники!

Здесь вы можете:
• Задать юридический вопрос
• Просмотреть часто задаваемые вопросы (FAQ)
• Отслеживать статус ваших обращений

Выберите действие из меню ниже:
`;
    
    await ctx.reply(welcomeMessage, getMainMenuKeyboard());
    await logAction('user_start_command', { userId: user._id });
  } catch (error) {
    console.error('Error in start handler:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};