const Log = require('./models/log');

/**
 * Log an action in the system
 * @param {String} action - Action name (e.g., 'user_sent_request')
 * @param {Object} details - Details of the action (userId, requestId, etc.)
 * @returns {Promise<Object>} - Created log object
 */
const logAction = async (action, details = {}) => {
  try {
    const log = new Log({
      action,
      details
    });
    await log.save();
    return log;
  } catch (error) {
    console.error(`Error logging action ${action}:`, error);
    // Even if logging fails, we don't want to break the application flow
    return null;
  }
};

module.exports = { logAction };