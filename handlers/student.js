const { Markup } = require('telegraf');
const User = require('../models/user');
const Request = require('../models/request');
const { getOrCreateUser, getMainMenuKeyboard, isStudent } = require('./common');
const { logAction } = require('../logger');

// Student state management (in-memory for simplicity)
const studentStates = new Map();

/**
 * Handle "Взять в работу" button
 */
const handleTakeRequest = async (ctx, bot) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    // Get request
    const request = await Request.findById(requestId)
      .populate('categoryId');
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    if (request.status !== 'approved') {
      await ctx.answerCallbackQuery('Это обращение уже взято в работу или находится в другом статусе.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    // Check if student already has an active assignment
    if (user.currentAssignmentId) {
      await ctx.answerCallbackQuery('Вы уже обрабатываете другое обращение. Завершите его, прежде чем брать новое.');
      return;
    }
    
    // Set user role to student if needed
    if (user.role === 'user') {
      user.role = 'student';
      await user.save();
      await logAction('user_became_student', { userId: user._id });
    }
    
    // Update request with student
    request.status = 'assigned';
    request.studentId = user._id;
    await request.save();
    
    // Update user with active assignment
    user.currentAssignmentId = request._id;
    await user.save();
    
    // Update message in student chat
    const studentName = user.username ? `@${user.username}` : `${user.firstName || 'Студент'} ${user.lastName || ''}`;
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + `\n\nПринято в работу: ${studentName}`,
      { reply_markup: { inline_keyboard: [] } }
    );
    
    // Send request details to student in private chat
    const detailMessage = `
📨 Обращение #${request._id}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}

📝 Текст обращения:
${request.text}

Напишите ваш ответ на это обращение и отправьте его. После этого нажмите кнопку "Подтвердить отправку ответа".
`;

    await bot.telegram.sendMessage(
      user.telegramId,
      detailMessage,
      Markup.keyboard([
        ['Отказаться от обращения']
      ]).resize()
    );
    
    // Set student state to writing answer
    studentStates.set(user.telegramId, { 
      state: 'writing_answer',
      requestId: request._id
    });
    
    await ctx.answerCallbackQuery('Обращение взято в работу.');
    await logAction('student_took_request', { 
      studentId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling take request:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle student answer
 */
const handleStudentAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isStudent(user) || !user.currentAssignmentId) {
      return; // Not a student or no active assignment
    }
    
    const studentState = studentStates.get(user.telegramId);
    if (!studentState || studentState.state !== 'writing_answer') {
      return;
    }
    
    const answerText = ctx.message.text;
    
    // Update student state
    studentStates.set(user.telegramId, { 
      state: 'confirming_answer',
      requestId: studentState.requestId,
      answerText
    });
    
    await ctx.reply(
      'Проверьте ваш ответ:\n\n' + answerText,
      Markup.keyboard([
        ['Подтвердить отправку ответа'],
        ['Изменить ответ'],
        ['Отказаться от обращения']
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling student answer:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle "Подтвердить отправку ответа" button
 */
const handleConfirmAnswer = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isStudent(user) || !user.currentAssignmentId) {
      await ctx.reply('У вас нет активных обращений.');
      return;
    }
    
    const studentState = studentStates.get(user.telegramId);
    if (!studentState || studentState.state !== 'confirming_answer') {
      await ctx.reply('Сначала напишите ответ на обращение.');
      return;
    }
    
    const request = await Request.findById(studentState.requestId)
      .populate('categoryId');
    
    if (!request) {
      await ctx.reply('Обращение не найдено.');
      return;
    }
    
    // Update request with answer
    request.status = 'answered';
    request.answerText = studentState.answerText;
    await request.save();
    
    // Send answer to admin chat for approval
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const adminMessage = `
📨 Ответ на обращение #${request._id}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}
👨‍💼 Студент: ${user.username ? `@${user.username}` : user.telegramId}

📝 Текст обращения:
${request.text}

✏️ Ответ студента:
${request.answerText}
`;

    await bot.telegram.sendMessage(adminChatId, adminMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить', callback_data: `approve_answer:${request._id}` },
            { text: '❌ Отклонить', callback_data: `decline_answer:${request._id}` }
          ]
        ]
      }
    });
    
    await ctx.reply('Ваш ответ отправлен на проверку администратору. Вы получите уведомление, когда ответ будет проверен.');
    studentStates.delete(user.telegramId);
    
    await logAction('student_submitted_answer', { 
      studentId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling confirm answer:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle "Изменить ответ" button
 */
const handleEditAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isStudent(user) || !user.currentAssignmentId) {
      await ctx.reply('У вас нет активных обращений.');
      return;
    }
    
    const studentState = studentStates.get(user.telegramId);
    if (!studentState) {
      return;
    }
    
    // Update student state
    studentStates.set(user.telegramId, { 
      state: 'writing_answer',
      requestId: studentState.requestId
    });
    
    await ctx.reply(
      'Введите ваш ответ заново:',
      Markup.keyboard([
        ['Отказаться от обращения']
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling edit answer:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit answer callback
 */
const handleEditAnswerCallback = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];
    
    const request = await Request.findById(requestId)
      .populate('categoryId');
    
    if (!request) {
      await ctx.answerCallbackQuery('Обращение не найдено.');
      return;
    }
    
    const user = await getOrCreateUser(ctx);
    
    if (request.studentId.toString() !== user._id.toString()) {
      await ctx.answerCallbackQuery('Это обращение назначено другому студенту.');
      return;
    }
    
    // Update student state
    studentStates.set(user.telegramId, { 
      state: 'writing_answer',
      requestId: request._id
    });
    
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Введите ваш ответ заново:',
      Markup.keyboard([
        ['Отказаться от обращения']
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling edit answer callback:', error);
    await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle "Отказаться от обращения" button or callback
 */
const handleRejectAssignment = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    if (!isStudent(user) || !user.currentAssignmentId) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery('У вас нет активных обращений.');
      } else {
        await ctx.reply('У вас нет активных обращений.');
      }
      return;
    }
    
    let requestId;
    
    // Handle both text button and callback
    if (ctx.callbackQuery) {
      requestId = ctx.callbackQuery.data.split(':')[1];
      await ctx.answerCallbackQuery();
    } else {
      requestId = user.currentAssignmentId;
    }
    
    const request = await Request.findById(requestId)
      .populate('categoryId');
    
    if (!request) {
      await ctx.reply('Обращение не найдено.');
      return;
    }
    
    // Update request and user
    request.status = 'approved';
    request.studentId = null;
    await request.save();
    
    user.currentAssignmentId = null;
    await user.save();
    
    // Send back to student chat
    const studentChatId = process.env.STUDENT_CHAT_ID;
    const studentMessage = `
📨 Обращение #${request._id} (возвращено в очередь)
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
    
    if (ctx.callbackQuery) {
      await ctx.reply('Вы отказались от обращения. Оно возвращено в общую очередь.');
    } else {
      await ctx.reply('Вы отказались от обращения. Оно возвращено в общую очередь.');
    }
    
    await ctx.reply('Выберите действие:', getMainMenuKeyboard());
    studentStates.delete(user.telegramId);
    
    await logAction('student_rejected_assignment', { 
      studentId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling reject assignment:', error);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    } else {
      await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    }
  }
};

module.exports = {
  handleTakeRequest,
  handleStudentAnswer,
  handleConfirmAnswer,
  handleEditAnswer,
  handleEditAnswerCallback,
  handleRejectAssignment,
  studentStates
};