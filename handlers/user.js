const { Markup } = require('telegraf');
const { getOrCreateUser, getMainMenuKeyboard, getBackKeyboard } = require('./common');
const Category = require('../models/category');
const Request = require('../models/request');
const FAQ = require('../models/faq');
const { logAction } = require('../logger');

// User state management (in-memory for simplicity)
const userStates = new Map();

/**
 * Handle "Задать вопрос" action
 */
const handleAskQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В данный момент нет доступных категорий. Пожалуйста, попробуйте позже.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }

    // Create keyboard with categories
    const keyboard = [];
    categories.forEach(category => {
      keyboard.push([category.name]);
    });
    keyboard.push(['Назад']);

    // Set user state to selecting category
    userStates.set(user.telegramId, { 
      state: 'selecting_category'
    });

    await ctx.reply('Выберите категорию вашего вопроса:', Markup.keyboard(keyboard).resize());
    await logAction('user_selecting_category', { userId: user._id });
  } catch (error) {
    console.error('Error handling ask question:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle category selection
 */
const handleCategorySelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categoryName = ctx.message.text;

    const category = await Category.findOne({ name: categoryName });
    if (!category) {
      await ctx.reply('Категория не найдена. Пожалуйста, выберите из списка.');
      return;
    }

    // Update user state with selected category
    userStates.set(user.telegramId, { 
      state: 'entering_request',
      categoryId: category._id
    });

    await ctx.reply(
      'Введите текст вашего юридического вопроса (не менее 150 символов):', 
      getBackKeyboard()
    );
    await logAction('user_selected_category', { 
      userId: user._id, 
      categoryId: category._id 
    });
  } catch (error) {
    console.error('Error handling category selection:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle request text entry
 */
const handleRequestText = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const requestText = ctx.message.text;

    if (requestText.length < 150) {
      await ctx.reply('Текст обращения должен содержать не менее 150 символов. Пожалуйста, дополните ваш вопрос.');
      return;
    }

    const userState = userStates.get(user.telegramId);
    
    // Update user state with request text
    userStates.set(user.telegramId, { 
      ...userState,
      state: 'confirming_request',
      requestText
    });

    await ctx.reply(
      'Проверьте текст вашего обращения:\n\n' + requestText,
      Markup.keyboard([
        ['Подтвердить'],
        ['Изменить'],
        ['Назад']
      ]).resize()
    );
    
    await logAction('user_entered_request', { 
      userId: user._id, 
      categoryId: userState.categoryId,
      textLength: requestText.length
    });
  } catch (error) {
    console.error('Error handling request text:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle request confirmation
 */
const handleRequestConfirmation = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);
    
    if (!userState || !userState.categoryId || !userState.requestText) {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }

    const category = await Category.findById(userState.categoryId);
    
    // Create request in database
    const request = new Request({
      userId: user._id,
      categoryId: userState.categoryId,
      text: userState.requestText,
      status: 'pending'
    });
    
    await request.save();
    
    // Send request to admin chat
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const adminMessage = `
📨 Новое обращение #${request._id}
📂 Категория: ${category.name} ${category.hashtag}

📝 Текст обращения:
${userState.requestText}
`;

    await bot.telegram.sendMessage(adminChatId, adminMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_request:${request._id}` },
            { text: '❌ Отклонить', callback_data: `decline_request:${request._id}` }
          ]
        ]
      }
    });

    // Reset user state
    userStates.delete(user.telegramId);
    
    await ctx.reply('Ваше обращение успешно отправлено! Мы уведомим вас, когда оно будет рассмотрено.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
    
    await logAction('user_submitted_request', { 
      userId: user._id, 
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling request confirmation:', error);
    await ctx.reply('Произошла ошибка при отправке обращения. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle "Мои обращения" action
 */
const handleMyRequests = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    const requests = await Request.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .populate('categoryId');
    
    if (requests.length === 0) {
      await ctx.reply('У вас пока нет обращений.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }
    
    let message = '📋 Ваши обращения:\n\n';
    
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
      
      message += `${index + 1}. ${request.categoryId.name} - ${statusMap[request.status]}\n`;
      message += `   Дата: ${date}\n`;
      
      if (request.status === 'closed' && request.answerText) {
        message += `   [Просмотреть ответ](tg://request?${request._id})\n`;
      }
      
      if (request.status === 'declined' && request.adminComment) {
        message += `   Комментарий: ${request.adminComment}\n`;
      }
      
      message += '\n';
    });
    
    await ctx.reply(message);
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
    
    await logAction('user_viewed_requests', { userId: user._id });
  } catch (error) {
    console.error('Error handling my requests:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle "FAQ" action
 */
const handleFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В данный момент нет доступных категорий FAQ. Пожалуйста, попробуйте позже.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }

    // Create keyboard with categories
    const keyboard = [];
    categories.forEach(category => {
      keyboard.push([category.name]);
    });
    keyboard.push(['Назад']);

    // Set user state to selecting FAQ category
    userStates.set(user.telegramId, { 
      state: 'selecting_faq_category'
    });

    await ctx.reply('Выберите категорию FAQ:', Markup.keyboard(keyboard).resize());
    await logAction('user_viewing_faq', { userId: user._id });
  } catch (error) {
    console.error('Error handling FAQ:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle FAQ category selection
 */
const handleFAQCategorySelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categoryName = ctx.message.text;

    const category = await Category.findOne({ name: categoryName });
    if (!category) {
      await ctx.reply('Категория не найдена. Пожалуйста, выберите из списка.');
      return;
    }

    const faqs = await FAQ.find({ categoryId: category._id });

    if (faqs.length === 0) {
      await ctx.reply('В этой категории пока нет вопросов.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }

    // Create keyboard with FAQs
    const keyboard = [];
    faqs.forEach(faq => {
      keyboard.push([faq.question]);
    });
    keyboard.push(['Назад']);

    // Update user state with selected category
    userStates.set(user.telegramId, { 
      state: 'selecting_faq',
      categoryId: category._id,
      faqs: faqs.reduce((acc, faq) => {
        acc[faq.question] = faq;
        return acc;
      }, {})
    });

    await ctx.reply('Выберите вопрос:', Markup.keyboard(keyboard).resize());
    await logAction('user_selected_faq_category', { 
      userId: user._id, 
      categoryId: category._id 
    });
  } catch (error) {
    console.error('Error handling FAQ category selection:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle FAQ question selection
 */
const handleFAQSelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);
    
    if (!userState || !userState.faqs) {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }
    
    const question = ctx.message.text;
    const faq = userState.faqs[question];
    
    if (!faq) {
      await ctx.reply('Вопрос не найден. Пожалуйста, выберите из списка.');
      return;
    }
    
    // Send FAQ answer
    await ctx.reply(`📌 Вопрос: ${faq.question}\n\n📝 Ответ: ${faq.answer}`);
    await ctx.reply('Выберите другой вопрос или вернитесь назад:', getBackKeyboard());
    
    await logAction('user_viewed_faq', { 
      userId: user._id, 
      faqId: faq._id 
    });
  } catch (error) {
    console.error('Error handling FAQ selection:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

/**
 * Handle "Назад" (back) button
 */
const handleBack = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);
    
    if (!userState) {
      await ctx.reply('Выберите действие:', getMainMenuKeyboard());
      return;
    }
    
    // Depending on current state, go back to appropriate menu
    switch (userState.state) {
      case 'selecting_category':
      case 'selecting_faq_category':
        userStates.delete(user.telegramId);
        await ctx.reply('Выберите действие:', getMainMenuKeyboard());
        break;
        
      case 'entering_request':
        userStates.set(user.telegramId, { state: 'selecting_category' });
        const categories = await Category.find().sort({ name: 1 });
        const keyboard = categories.map(category => [category.name]);
        keyboard.push(['Назад']);
        await ctx.reply('Выберите категорию вашего вопроса:', Markup.keyboard(keyboard).resize());
        break;
        
      case 'confirming_request':
        userStates.set(user.telegramId, { 
          state: 'entering_request',
          categoryId: userState.categoryId
        });
        await ctx.reply('Введите текст вашего юридического вопроса (не менее 150 символов):', getBackKeyboard());
        break;
        
      case 'selecting_faq':
        userStates.set(user.telegramId, { state: 'selecting_faq_category' });
        const faqCategories = await Category.find().sort({ name: 1 });
        const faqKeyboard = faqCategories.map(category => [category.name]);
        faqKeyboard.push(['Назад']);
        await ctx.reply('Выберите категорию FAQ:', Markup.keyboard(faqKeyboard).resize());
        break;
        
      default:
        userStates.delete(user.telegramId);
        await ctx.reply('Выберите действие:', getMainMenuKeyboard());
    }
    
    await logAction('user_pressed_back', { userId: user._id });
  } catch (error) {
    console.error('Error handling back button:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
  }
};

module.exports = {
  handleAskQuestion,
  handleCategorySelection,
  handleRequestText,
  handleRequestConfirmation,
  handleMyRequests,
  handleFAQ,
  handleFAQCategorySelection,
  handleFAQSelection,
  handleBack,
  userStates
};