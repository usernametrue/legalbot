require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const mongoose = require('mongoose');

// Import handlers
const startHandler = require('./handlers/start');
const userHandlers = require('./handlers/user');
const adminHandlers = require('./handlers/admin');
const studentHandlers = require('./handlers/student');
const categoryHandlers = require('./handlers/category');
const faqHandlers = require('./handlers/faq');
const requestHandlers = require('./handlers/request');

// Import logger
const { logAction } = require('./logger');

// Check required environment variables
const requiredEnvVars = ['BOT_TOKEN', 'MONGO_URI', 'ADMIN_CHAT_ID', 'STUDENT_CHAT_ID'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch(err => {
    console.error('Error connecting to MongoDB:', err);
    process.exit(1);
  });

// Setup middleware
bot.use(session());

// Log all messages
bot.use(async (ctx, next) => {
  try {
    if (ctx.message && ctx.message.text) {
      const user = ctx.from;
      console.log(`[${new Date().toISOString()}] ${user.username || user.id}: ${ctx.message.text}`);
    }
    return next();
  } catch (error) {
    console.error('Error in logging middleware:', error);
    return next();
  }
});

// Command handlers
bot.start(startHandler);

// Admin commands
bot.command('getadmin', adminHandlers.handleGetAdmin);
bot.command('add_category', adminHandlers.handleAddCategory);
bot.command('edit_category', adminHandlers.handleEditCategory);
bot.command('delete_category', adminHandlers.handleDeleteCategory);
bot.command('add_faq', adminHandlers.handleAddFAQ);
bot.command('edit_faq', adminHandlers.handleEditFAQ);
bot.command('delete_faq', adminHandlers.handleDeleteFAQ);
bot.command('categories', categoryHandlers.handleListCategories);
bot.command('faqs', faqHandlers.handleListFAQs);
bot.command('requests', requestHandlers.handleListRequests);
bot.command('stats', requestHandlers.handleStats);

// User action handlers
bot.hears('Задать вопрос', userHandlers.handleAskQuestion);
bot.hears('FAQ', userHandlers.handleFAQ);
bot.hears('Мои обращения', userHandlers.handleMyRequests);
bot.hears('Назад', userHandlers.handleBack);

// Admin callback handlers
bot.action(/approve_request:(.+)/, (ctx) => adminHandlers.handleApproveRequest(ctx, bot));
bot.action(/decline_request:(.+)/, adminHandlers.handleDeclineRequest);
bot.action(/approve_answer:(.+)/, (ctx) => adminHandlers.handleApproveAnswer(ctx, bot));
bot.action(/decline_answer:(.+)/, adminHandlers.handleDeclineAnswer);
bot.action(/edit_category:(.+)/, adminHandlers.handleEditCategorySelection);
bot.action(/edit_category_name:(.+)/, adminHandlers.handleEditCategoryName);
bot.action(/edit_category_hashtag:(.+)/, adminHandlers.handleEditCategoryHashtag);
bot.action(/delete_category:(.+)/, adminHandlers.handleDeleteCategorySelection);
bot.action(/confirm_delete_category:(.+)/, adminHandlers.handleDeleteCategoryConfirmation);
bot.action(/select_faq_category:(.+)/, adminHandlers.handleFAQCategorySelectionAdmin);
bot.action(/edit_faq_select_category:(.+)/, adminHandlers.handleEditFAQCategorySelection);
bot.action(/edit_faq:(.+)/, adminHandlers.handleEditFAQSelection);
bot.action(/edit_faq_question:(.+)/, adminHandlers.handleEditFAQQuestion);
bot.action(/edit_faq_answer:(.+)/, adminHandlers.handleEditFAQAnswer);
bot.action(/edit_faq_category:(.+)/, adminHandlers.handleEditFAQCategory);
bot.action(/set_faq_category:(.+)/, adminHandlers.handleSetFAQCategory);
bot.action(/delete_faq_select_category:(.+)/, adminHandlers.handleDeleteFAQSelection);
bot.action(/delete_faq:(.+)/, adminHandlers.handleDeleteFAQ);
bot.action(/confirm_delete_faq:(.+)/, adminHandlers.handleConfirmDeleteFAQ);
bot.action('cancel_edit_category', adminHandlers.handleCancel);
bot.action('cancel_delete_category', adminHandlers.handleCancel);
bot.action('cancel_edit_faq', adminHandlers.handleCancel);
bot.action('cancel_delete_faq', adminHandlers.handleCancel);

// Student callback handlers
bot.action(/take_request:(.+)/, (ctx) => studentHandlers.handleTakeRequest(ctx, bot));
bot.action(/edit_answer:(.+)/, studentHandlers.handleEditAnswerCallback);
bot.action(/reject_assignment:(.+)/, (ctx) => studentHandlers.handleRejectAssignment(ctx, bot));

// Student button handlers
bot.hears('Подтвердить отправку ответа', (ctx) => studentHandlers.handleConfirmAnswer(ctx, bot));
bot.hears('Изменить ответ', studentHandlers.handleEditAnswer);
bot.hears('Отказаться от обращения', (ctx) => studentHandlers.handleRejectAssignment(ctx, bot));

// Handle category selection in user flow
bot.on('message', async (ctx, next) => {
  try {
    const userState = userHandlers.userStates.get(ctx.from.id);
    
    if (!userState) {
      return next();
    }
    
    // Handle different states
    switch (userState.state) {
      case 'selecting_category':
        await userHandlers.handleCategorySelection(ctx);
        break;
      case 'entering_request':
        await userHandlers.handleRequestText(ctx);
        break;
      case 'confirming_request':
        if (ctx.message.text === 'Подтвердить') {
          await userHandlers.handleRequestConfirmation(ctx, bot);
        } else if (ctx.message.text === 'Изменить') {
          await userHandlers.handleEditAnswer(ctx);
        }
        break;
      case 'selecting_faq_category':
        await userHandlers.handleFAQCategorySelection(ctx);
        break;
      case 'selecting_faq':
        await userHandlers.handleFAQSelection(ctx);
        break;
      default:
        return next();
    }
  } catch (error) {
    console.error('Error in user state handler:', error);
    return next();
  }
});

// Handle admin state management
bot.on('message', async (ctx, next) => {
  try {
    const adminState = adminHandlers.adminStates.get(ctx.from.id);
    
    if (!adminState) {
      return next();
    }
    
    // Handle different admin states
    switch (adminState.state) {
      case 'entering_decline_reason':
        await adminHandlers.handleDeclineReason(ctx, bot);
        break;
      case 'entering_answer_decline_reason':
        await adminHandlers.handleAnswerDeclineReason(ctx, bot);
        break;
      case 'entering_category_name':
        await adminHandlers.handleCategoryName(ctx);
        break;
      case 'entering_category_hashtag':
        await adminHandlers.handleCategoryHashtag(ctx);
        break;
      case 'entering_new_category_name':
        await adminHandlers.handleNewCategoryName(ctx);
        break;
      case 'entering_new_category_hashtag':
        await adminHandlers.handleNewCategoryHashtag(ctx);
        break;
      case 'entering_faq_question':
        await adminHandlers.handleFAQQuestion(ctx);
        break;
      case 'entering_faq_answer':
        await adminHandlers.handleFAQAnswer(ctx);
        break;
      default:
        return next();
    }
  } catch (error) {
    console.error('Error in admin state handler:', error);
    return next();
  }
});

// Handle student answer submission
bot.on('message', async (ctx, next) => {
  try {
    // Skip command messages
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
      return next();
    }
    
    // Skip if there's no text or button text is matched
    if (!ctx.message.text || (
      ['Подтвердить отправку ответа', 'Изменить ответ', 'Отказаться от обращения', 
      'Задать вопрос', 'FAQ', 'Мои обращения', 'Назад', 'Подтвердить', 'Изменить']
        .includes(ctx.message.text)
    )) {
      return next();
    }
    
    const studentState = studentHandlers.studentStates.get(ctx.from.id);
    
    if (studentState && studentState.state === 'writing_answer') {
      await studentHandlers.handleStudentAnswer(ctx);
    } else {
      return next();
    }
  } catch (error) {
    console.error('Error in student answer handler:', error);
    return next();
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  
  // Try to respond to user when error occurs
  try {
    ctx.reply('Произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте еще раз позже.');
  } catch (replyErr) {
    console.error('Error sending error message:', replyErr);
  }
  
  // Log the error
  logAction('bot_error', {
    error: err.message,
    stack: err.stack,
    updateType: ctx.updateType,
    userId: ctx.from ? ctx.from.id : null
  });
});

// Launch bot
bot.launch()
  .then(() => {
    console.log('Bot started successfully');
    logAction('bot_started');
  })
  .catch(err => {
    console.error('Error starting bot:', err);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  console.log('Bot stopped due to SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  console.log('Bot stopped due to SIGTERM');
  process.exit(0);
});