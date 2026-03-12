// lib/utils/validate.js
const { validatePhone } = require('./phone'); // Импортируем валидатор телефона из соседнего файла

/**
 * Проверяет объект с данными лида на наличие обязательных полей и корректность формата.
 * Бросает ошибку (throws Error), если валидация не пройдена.
 * @param {object} leadData - Объект с данными лида (name, phone, service и т.д.).
 * @returns {boolean} - True, если все в порядке.
 * @throws {Error} - Если валидация не пройдена, с деталями в error.details.
 */
function validateLeadData(leadData) {
  const errors = [];
  if (!leadData) {
      errors.push('Lead data object is missing.');
      // Дальше нет смысла проверять, если нет самого объекта
      const error = new Error('Lead validation failed');
      error.details = errors;
      throw error;
  }

  // Проверяем обязательные поля
  if (!leadData.name) {
      errors.push('Name is required.');
  }
  if (!leadData.phone) {
      errors.push('Phone is required.');
  } else if (!validatePhone(leadData.phone)) { // Проверяем формат телефона через утилиту
      errors.push('Invalid phone format provided.');
  }
  // Добавим проверку на Service, так как он важен для тебя
  if (!leadData.service) {
      errors.push('Service is required.');
  }
  // Добавь сюда другие обязательные проверки, если нужно

  // Если были ошибки, формируем и бросаем одно исключение
  if (errors.length > 0) {
    const error = new Error(`Lead validation failed: ${errors.join(' ')}`);
    error.details = errors; // Сохраняем список ошибок для логов
    throw error;
  }

  // Если ошибок не было
  return true;
}

module.exports = { validateLeadData }; // Экспортируем функцию