const { Markup } = require('telegraf');
const User = require('../models/user');
const Request = require('../models/request');
const Category = require('../models/category');
const FAQ = require('../models/faq');
const { getOrCreateUser, isAdmin } = require('./common');
const { logAction } = require('../logger');

// Admin state management (in-memory for simplicity)
const adminStates = new Map();

/**
 * Handle /getadmin command
 */
const handleGetAdmin = async (ctx) => {
  try {
    // Check if the command is from the admin chat
    if (ctx.chat.id.toString() !== process.env.ADMIN_CHAT_ID) {
      await ctx.reply('Эта команда доступна только в администраторском чате.');
      return;
    }

    const user = await getOrCreateUser(ctx);
    
    // Update user role to admin
    user.role = 'admin';
    await user.save();
    
    await ctx.reply(`Пользователь @${user.username || user.telegramId} получил права администратора.`);
    await logAction('user_became_admin', { userId: user._id });
  } catch (error) {
    console.error('Error handling get admin command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle request approval
 */
const handleApproveRequest = async (ctx, bot) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId');
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    if (request.status !== 'pending') {
      await ctx.answerCallbackQuery('Это обращение уже обработано.');
      return;
    }
    
    // Update request status
    request.status = 'approved';
    await request.save();
    
    // Notify user
    await bot.telegram.sendMessage(
      request.userId.telegramId,
      `✅ Ваше обращение по категории "${request.categoryId.name}" принято к обработке.`
    );
    
    // Send to student chat
    const studentChatId = process.env.STUDENT_CHAT_ID;
    const studentMessage = `
📨 Новое обращение #${request._id}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}

📝 Текст обращения:
${request.text}
`;

    await bot.telegram.sendMessage(studentChatId, studentMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Взять в работу', callback_data: `take_request:${request._id}` }
          ]
        ]
      }
    });
    
    // Update callback message
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ Одобрено',
      { reply_markup: { inline_keyboard: [] } }
    );
    
    await ctx.answerCallbackQuery('Обращение одобрено и отправлено студентам.');
    await logAction('admin_approved_request', { 
      adminId: ctx.from.id,
      requestId: request._id 
    });
  } catch (error) {
    console.error('Error handling approve request:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle request decline - initial step
 */
const handleDeclineRequest = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    const request = await Request.findById(requestId);
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    if (request.status !== 'pending') {
      await ctx.answerCallbackQuery('Это обращение уже обработано.');
      return;
    }
    
    // Set admin state to entering decline reason
    const user = await getOrCreateUser(ctx);
    adminStates.set(user.telegramId, { 
      state: 'entering_decline_reason',
      requestId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Введите причину отклонения обращения #${requestId}:`,
      Markup.forceReply()
    );
  } catch (error) {
    console.error('Error handling decline request:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle decline reason entry
 */
const handleDeclineReason = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_decline_reason') {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      return;
    }
    
    const requestId = adminState.requestId;
    const declineReason = ctx.message.text;
    
    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId');
    
    if (!request) {
      await ctx.reply('Обращение не найдено.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    if (request.status !== 'pending') {
      await ctx.reply('Это обращение уже обработано.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    // Update request
    request.status = 'declined';
    request.adminComment = declineReason;
    await request.save();
    
    // Notify user
    await bot.telegram.sendMessage(
      request.userId.telegramId,
      `❌ Ваше обращение по категории "${request.categoryId.name}" отклонено.\n\nПричина: ${declineReason}`
    );
    
    // Find original message in admin chat and update it
    const adminChatId = process.env.ADMIN_CHAT_ID;
    
    // Update all admin messages about this request
    try {
      // This requires finding the message, which may not be straightforward
      // without storing message IDs. For simplicity, we'll just send a new message.
      await bot.telegram.sendMessage(
        adminChatId,
        `❌ Обращение #${request._id} отклонено.\nПричина: ${declineReason}`
      );
    } catch (err) {
      console.error('Error updating admin message:', err);
    }
    
    await ctx.reply(`Обращение #${request._id} успешно отклонено.`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_declined_request', { 
      adminId: user._id,
      requestId: request._id,
      reason: declineReason
    });
  } catch (error) {
    console.error('Error handling decline reason:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle approve student answer
 */
const handleApproveAnswer = async (ctx, bot) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId')
      .populate('studentId');
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    if (request.status !== 'answered') {
      await ctx.answerCallbackQuery('Это обращение находится в неправильном статусе.');
      return;
    }
    
    // Update request status
    request.status = 'closed';
    await request.save();
    
    // Update student's active assignment
    const student = request.studentId;
    student.currentAssignmentId = null;
    await student.save();
    
    // Notify user
    await bot.telegram.sendMessage(
      request.userId.telegramId,
      `✅ Ваш запрос по категории "${request.categoryId.name}" был обработан.\n\n📝 Ответ:\n${request.answerText}`
    );
    
    // Notify student
    await bot.telegram.sendMessage(
      student.telegramId,
      `✅ Ваш ответ на обращение #${request._id} был одобрен и отправлен пользователю.`
    );
    
    // Update callback message
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ Одобрено и отправлено пользователю',
      { reply_markup: { inline_keyboard: [] } }
    );
    
    await ctx.answerCallbackQuery('Ответ одобрен и отправлен пользователю.');
    await logAction('admin_approved_answer', { 
      adminId: ctx.from.id,
      requestId: request._id,
      studentId: student._id
    });
  } catch (error) {
    console.error('Error handling approve answer:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle decline student answer - initial step
 */
const handleDeclineAnswer = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    const request = await Request.findById(requestId);
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    if (request.status !== 'answered') {
      await ctx.answerCallbackQuery('Это обращение находится в неправильном статусе.');
      return;
    }
    
    // Set admin state to entering decline reason
    const user = await getOrCreateUser(ctx);
    adminStates.set(user.telegramId, { 
      state: 'entering_answer_decline_reason',
      requestId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Введите комментарий к ответу на обращение #${requestId}:`,
      Markup.forceReply()
    );
  } catch (error) {
    console.error('Error handling decline answer:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle decline answer reason entry
 */
const handleAnswerDeclineReason = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_answer_decline_reason') {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      return;
    }
    
    const requestId = adminState.requestId;
    const declineReason = ctx.message.text;
    
    const request = await Request.findById(requestId)
      .populate('studentId')
      .populate('categoryId');
    
    if (!request) {
      await ctx.reply('Обращение не найдено.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    if (request.status !== 'answered') {
      await ctx.reply('Это обращение находится в неправильном статусе.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    // Update request
    request.adminComment = declineReason;
    await request.save();
    
    // Notify student
    await bot.telegram.sendMessage(
      request.studentId.telegramId,
      `❌ Ваш ответ на обращение #${request._id} по категории "${request.categoryId.name}" был отклонен.\n\nКомментарий: ${declineReason}\n\nВыберите действие:`,
      Markup.inlineKeyboard([
        [
          { text: '✏️ Отправить новый ответ', callback_data: `edit_answer:${request._id}` },
          { text: '❌ Отказаться от обращения', callback_data: `reject_assignment:${request._id}` }
        ]
      ])
    );
    
    // Update callback message
    try {
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n❌ Отклонено\nПричина: ' + declineReason,
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (err) {
      console.error('Error updating admin message:', err);
      await bot.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID,
        `❌ Ответ на обращение #${request._id} отклонен.\nПричина: ${declineReason}`
      );
    }
    
    await ctx.reply(`Ответ на обращение #${request._id} успешно отклонен.`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_declined_answer', { 
      adminId: user._id,
      requestId: request._id,
      studentId: request.studentId._id,
      reason: declineReason
    });
  } catch (error) {
    console.error('Error handling answer decline reason:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /add_category command
 */
const handleAddCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Set admin state to entering category name
    adminStates.set(user.telegramId, { 
      state: 'entering_category_name'
    });
    
    await ctx.reply('Введите название новой категории:');
    await logAction('admin_adding_category', { userId: user._id });
  } catch (error) {
    console.error('Error handling add category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle category name entry
 */
const handleCategoryName = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_category_name') {
      return;
    }
    
    const categoryName = ctx.message.text;
    
    // Check if category already exists
    const existingCategory = await Category.findOne({ name: categoryName });
    if (existingCategory) {
      await ctx.reply('Категория с таким названием уже существует. Пожалуйста, выберите другое название.');
      return;
    }
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_category_hashtag',
      categoryName
    });
    
    await ctx.reply('Введите хештег для категории (например, #гражданское):');
  } catch (error) {
    console.error('Error handling category name entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle category hashtag entry
 */
const handleCategoryHashtag = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_category_hashtag') {
      return;
    }
    
    let hashtag = ctx.message.text;
    
    // Ensure hashtag starts with #
    if (!hashtag.startsWith('#')) {
      hashtag = '#' + hashtag;
    }
    
    // Check if hashtag already exists
    const existingCategory = await Category.findOne({ hashtag });
    if (existingCategory) {
      await ctx.reply('Категория с таким хештегом уже существует. Пожалуйста, выберите другой хештег.');
      return;
    }
    
    // Create new category
    const category = new Category({
      name: adminState.categoryName,
      hashtag
    });
    
    await category.save();
    
    await ctx.reply(`✅ Категория "${category.name}" с хештегом ${category.hashtag} успешно создана!`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_created_category', { 
      adminId: user._id,
      categoryId: category._id,
      categoryName: category.name
    });
  } catch (error) {
    console.error('Error handling category hashtag entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /edit_category command
 */
const handleEditCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    const keyboard = categories.map(category => [
      { text: `${category.name} (${category.hashtag})`, callback_data: `edit_category:${category._id}` }
    ]);
    
    await ctx.reply(
      'Выберите категорию для редактирования:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category selection
 */
const handleEditCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Set admin state
    adminStates.set(user.telegramId, { 
      state: 'editing_category',
      categoryId
    });
    
    const keyboard = [
      [{ text: 'Изменить название', callback_data: `edit_category_name:${categoryId}` }],
      [{ text: 'Изменить хештег', callback_data: `edit_category_hashtag:${categoryId}` }],
      [{ text: 'Отмена', callback_data: 'cancel_edit_category' }]
    ];
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Редактирование категории: ${category.name} (${category.hashtag})`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit category selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category name
 */
const handleEditCategoryName = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_new_category_name',
      categoryId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(`Текущее название: ${category.name}\n\nВведите новое название категории:`);
  } catch (error) {
    console.error('Error handling edit category name:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new category name entry
 */
const handleNewCategoryName = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_new_category_name') {
      return;
    }
    
    const newName = ctx.message.text;
    
    // Check if name already exists
    const existingCategory = await Category.findOne({ name: newName });
    if (existingCategory && existingCategory._id.toString() !== adminState.categoryId) {
      await ctx.reply('Категория с таким названием уже существует. Пожалуйста, выберите другое название.');
      return;
    }
    
    // Update category
    const category = await Category.findById(adminState.categoryId);
    if (!category) {
      await ctx.reply('Категория не найдена.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    const oldName = category.name;
    category.name = newName;
    await category.save();
    
    await ctx.reply(`✅ Название категории изменено с "${oldName}" на "${newName}".`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_updated_category_name', { 
      adminId: user._id,
      categoryId: category._id,
      oldName,
      newName
    });
  } catch (error) {
    console.error('Error handling new category name entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category hashtag
 */
const handleEditCategoryHashtag = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_new_category_hashtag',
      categoryId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(`Текущий хештег: ${category.hashtag}\n\nВведите новый хештег категории:`);
  } catch (error) {
    console.error('Error handling edit category hashtag:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new category hashtag entry
 */
const handleNewCategoryHashtag = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_new_category_hashtag') {
      return;
    }
    
    let newHashtag = ctx.message.text;
    
    // Ensure hashtag starts with #
    if (!newHashtag.startsWith('#')) {
      newHashtag = '#' + newHashtag;
    }
    
    // Check if hashtag already exists
    const existingCategory = await Category.findOne({ hashtag: newHashtag });
    if (existingCategory && existingCategory._id.toString() !== adminState.categoryId) {
      await ctx.reply('Категория с таким хештегом уже существует. Пожалуйста, выберите другой хештег.');
      return;
    }
    
    // Update category
    const category = await Category.findById(adminState.categoryId);
    if (!category) {
      await ctx.reply('Категория не найдена.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    const oldHashtag = category.hashtag;
    category.hashtag = newHashtag;
    await category.save();
    
    await ctx.reply(`✅ Хештег категории изменен с "${oldHashtag}" на "${newHashtag}".`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_updated_category_hashtag', { 
      adminId: user._id,
      categoryId: category._id,
      oldHashtag,
      newHashtag
    });
  } catch (error) {
    console.error('Error handling new category hashtag entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /delete_category command
 */
const handleDeleteCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    const keyboard = categories.map(category => [
      { text: `${category.name} (${category.hashtag})`, callback_data: `delete_category:${category._id}` }
    ]);
    
    await ctx.reply(
      'Выберите категорию для удаления:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete category selection
 */
const handleDeleteCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    // Check if category is in use
    const requestsCount = await Request.countDocuments({ categoryId });
    const faqsCount = await FAQ.countDocuments({ categoryId });
    
    if (requestsCount > 0 || faqsCount > 0) {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `Категория "${category.name}" не может быть удалена, так как она используется в ${requestsCount} обращениях и ${faqsCount} FAQ.`
      );
      return;
    }
    
    const keyboard = [
      [
        { text: 'Да, удалить', callback_data: `confirm_delete_category:${categoryId}` },
        { text: 'Отмена', callback_data: 'cancel_delete_category' }
      ]
    ];
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Вы уверены, что хотите удалить категорию "${category.name}" (${category.hashtag})?`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete category selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete category confirmation
 */
const handleDeleteCategoryConfirmation = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const categoryName = category.name;
    
    // Delete category
    await Category.deleteOne({ _id: categoryId });
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ Категория "${categoryName}" успешно удалена.`,
      { reply_markup: { inline_keyboard: [] } }
    );
    
    const user = await getOrCreateUser(ctx);
    await logAction('admin_deleted_category', { 
      adminId: user._id,
      categoryName
    });
  } catch (error) {
    console.error('Error handling delete category confirmation:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /add_faq command
 */
const handleAddFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Set admin state to entering FAQ question
    adminStates.set(user.telegramId, {
      state: 'entering_faq_question'
    });
    
    await ctx.reply('Введите вопрос для FAQ:');
    await logAction('admin_adding_faq', { userId: user._id });
  } catch (error) {
    console.error('Error handling add FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ question entry
 */
const handleFAQQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_faq_question') {
      return;
    }
    
    const question = ctx.message.text;
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_faq_answer',
      question
    });
    
    await ctx.reply('Введите ответ на вопрос:');
  } catch (error) {
    console.error('Error handling FAQ question entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ answer entry
 */
const handleFAQAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_faq_answer') {
      return;
    }
    
    const answer = ctx.message.text;
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'selecting_faq_category',
      question: adminState.question,
      answer
    });
    
    // Get categories for selection
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий. Сначала создайте категорию с помощью команды /add_category.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `select_faq_category:${category._id}` }
    ]);
    
    await ctx.reply(
      'Выберите категорию для вопроса:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling FAQ answer entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ category selection by admin
 */
const handleFAQCategorySelectionAdmin = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'selecting_faq_category') {
      await ctx.answerCallbackQuery('Что-то пошло не так. Пожалуйста, начните заново.');
      return;
    }
    
    // Create new FAQ
    const faq = new FAQ({
      question: adminState.question,
      answer: adminState.answer,
      categoryId
    });
    
    await faq.save();
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ Вопрос успешно добавлен в категорию "${category.name}".`,
      { reply_markup: { inline_keyboard: [] } }
    );
    
    adminStates.delete(user.telegramId);
    
    await logAction('admin_created_faq', { 
      adminId: user._id,
      faqId: faq._id,
      categoryId
    });
  } catch (error) {
    console.error('Error handling FAQ category selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /edit_faq command
 */
const handleEditFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Get categories for selection
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `edit_faq_select_category:${category._id}` }
    ]);
    
    await ctx.reply(
      'Выберите категорию для редактирования FAQ:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit FAQ category selection
 */
const handleEditFAQCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const faqs = await FAQ.find({ categoryId }).sort({ question: 1 });
    
    if (faqs.length === 0) {
      await ctx.answerCallbackQuery('В этой категории нет вопросов.');
      return;
    }
    
    const keyboard = faqs.map(faq => [
      { text: faq.question.substring(0, 50), callback_data: `edit_faq:${faq._id}` }
    ]);
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Выберите вопрос для редактирования:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ category selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit FAQ selection
 */
const handleEditFAQSelection = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    const keyboard = [
      [{ text: 'Изменить вопрос', callback_data: `edit_faq_question:${faqId}` }],
      [{ text: 'Изменить ответ', callback_data: `edit_faq_answer:${faqId}` }],
      [{ text: 'Изменить категорию', callback_data: `edit_faq_category:${faqId}` }],
      [{ text: 'Отмена', callback_data: 'cancel_edit_faq' }]
    ];
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Редактирование вопроса: ${faq.question}`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit FAQ question
 */
const handleEditFAQQuestion = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_new_faq_question',
      faqId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(`Текущий вопрос: ${faq.question}\n\nВведите новый вопрос:`);
  } catch (error) {
    console.error('Error handling edit FAQ question:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new FAQ question entry
 */
const handleNewFAQQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_new_faq_question') {
      return;
    }
    
    const newQuestion = ctx.message.text;
    
    // Update FAQ
    const faq = await FAQ.findById(adminState.faqId);
    if (!faq) {
      await ctx.reply('Вопрос не найден.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    const oldQuestion = faq.question;
    faq.question = newQuestion;
    await faq.save();
    
    await ctx.reply(`✅ Вопрос успешно обновлен.`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_updated_faq_question', { 
      adminId: user._id,
      faqId: faq._id,
      oldQuestion,
      newQuestion
    });
  } catch (error) {
    console.error('Error handling new FAQ question entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit FAQ answer
 */
const handleEditFAQAnswer = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'entering_new_faq_answer',
      faqId
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(`Текущий ответ: ${faq.answer}\n\nВведите новый ответ:`);
  } catch (error) {
    console.error('Error handling edit FAQ answer:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new FAQ answer entry
 */
const handleNewFAQAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);
    
    if (!adminState || adminState.state !== 'entering_new_faq_answer') {
      return;
    }
    
    const newAnswer = ctx.message.text;
    
    // Update FAQ
    const faq = await FAQ.findById(adminState.faqId);
    if (!faq) {
      await ctx.reply('Вопрос не найден.');
      adminStates.delete(user.telegramId);
      return;
    }
    
    const oldAnswer = faq.answer;
    faq.answer = newAnswer;
    await faq.save();
    
    await ctx.reply(`✅ Ответ успешно обновлен.`);
    adminStates.delete(user.telegramId);
    
    await logAction('admin_updated_faq_answer', { 
      adminId: user._id,
      faqId: faq._id
    });
  } catch (error) {
    console.error('Error handling new FAQ answer entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit FAQ category
 */
const handleEditFAQCategory = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId)
      .populate('categoryId');
    
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Get categories for selection
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length <= 1) {
      await ctx.answerCallbackQuery('Недостаточно категорий для изменения.');
      return;
    }
    
    // Update admin state
    adminStates.set(user.telegramId, { 
      state: 'selecting_new_faq_category',
      faqId
    });
    
    const keyboard = categories
      .filter(category => category._id.toString() !== faq.categoryId._id.toString())
      .map(category => [
        { text: category.name, callback_data: `set_faq_category:${faq._id}:${category._id}` }
      ]);
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Текущая категория: ${faq.categoryId.name}\n\nВыберите новую категорию:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ category:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle set FAQ category
 */
const handleSetFAQCategory = async (ctx) => {
  try {
    const parts = ctx.callbackQuery.data.split(':');
    const faqId = parts[1];
    const categoryId = parts[2];
    
    const faq = await FAQ.findById(faqId)
      .populate('categoryId');
    
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCallbackQuery('Категория не найдена.');
      return;
    }
    
    const oldCategory = faq.categoryId;
    
    // Update FAQ
    faq.categoryId = categoryId;
    await faq.save();
    
    const user = await getOrCreateUser(ctx);
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ Категория вопроса изменена с "${oldCategory.name}" на "${category.name}".`,
      { reply_markup: { inline_keyboard: [] } }
    );
    
    adminStates.delete(user.telegramId);
    
    await logAction('admin_updated_faq_category', { 
      adminId: user._id,
      faqId: faq._id,
      oldCategoryId: oldCategory._id,
      newCategoryId: categoryId
    });
  } catch (error) {
    console.error('Error handling set FAQ category:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /delete_faq command
 */
const handleDeleteFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    // Get categories for selection
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `delete_faq_select_category:${category._id}` }
    ]);
    
    await ctx.reply(
      'Выберите категорию для удаления FAQ:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete FAQ selection
 */
const handleDeleteFAQSelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];
    
    const faqs = await FAQ.find({ categoryId }).sort({ question: 1 });
    
    if (faqs.length === 0) {
      await ctx.answerCallbackQuery('В этой категории нет вопросов.');
      return;
    }
    
    const keyboard = faqs.map(faq => [
      { text: faq.question.substring(0, 50), callback_data: `delete_faq:${faq._id}` }
    ]);
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Выберите вопрос для удаления:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ selection:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete FAQ from category
 */
const handleDeleteFAQFromCategory = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    const keyboard = [
      [
        { text: 'Да, удалить', callback_data: `confirm_delete_faq:${faqId}` },
        { text: 'Отмена', callback_data: 'cancel_delete_faq' }
      ]
    ];
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Вы уверены, что хотите удалить вопрос "${faq.question.substring(0, 50)}"?`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle confirm delete FAQ
 */
const handleConfirmDeleteFAQ = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];
    
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCallbackQuery('Вопрос не найден.');
      return;
    }
    
    // Delete FAQ
    await FAQ.deleteOne({ _id: faqId });
    
    const user = await getOrCreateUser(ctx);
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ Вопрос успешно удален.`,
      { reply_markup: { inline_keyboard: [] } }
    );
    
    await logAction('admin_deleted_faq', { 
      adminId: user._id,
      question: faq.question
    });
  } catch (error) {
    console.error('Error handling confirm delete FAQ:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle cancel buttons
 */
const handleCancel = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    // Clear admin state
    adminStates.delete(user.telegramId);
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      'Операция отменена.',
      { reply_markup: { inline_keyboard: [] } }
    );
  } catch (error) {
    console.error('Error handling cancel:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

module.exports = {
  handleGetAdmin,
  handleApproveRequest,
  handleDeclineRequest,
  handleDeclineReason,
  handleApproveAnswer,
  handleDeclineAnswer,
  handleAnswerDeclineReason,
  handleAddCategory,
  handleCategoryName,
  handleCategoryHashtag,
  handleEditCategory,
  handleEditCategorySelection,
  handleEditCategoryName,
  handleNewCategoryName,
  handleEditCategoryHashtag,
  handleNewCategoryHashtag,
  handleDeleteCategory,
  handleDeleteCategorySelection,
  handleDeleteCategoryConfirmation,
  handleAddFAQ,
  handleFAQQuestion,
  handleFAQAnswer,
  handleFAQCategorySelectionAdmin,
  handleEditFAQ,
  handleEditFAQCategorySelection,
  handleEditFAQSelection,
  handleEditFAQQuestion,
  handleNewFAQQuestion,
  handleEditFAQAnswer,
  handleNewFAQAnswer,
  handleEditFAQCategory,
  handleSetFAQCategory,
  handleDeleteFAQ,
  handleDeleteFAQSelection,
  handleDeleteFAQFromCategory,
  handleConfirmDeleteFAQ,
  handleCancel,
  adminStates
};