// lib/utils/log.js
const pino = require('pino');
// Не импортируем config здесь, чтобы избежать цикличных зависимостей,
// читаем уровень лога напрямую из process.env
const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: logLevel,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
  base: undefined, // Убираем pid, hostname
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
    // Можно добавить request ID прямо в логгер, если он передан
    log: (obj) => {
      if (obj.reqId) {
        // Добавляем reqId в стандартный вывод pino, если он есть
      }
      return obj;
    }
  },
  // Добавим reqId в стандартный вывод, если передан в объект лога
   messageKey: 'msg', // Используем 'msg' для основного сообщения
   errorKey: 'err', // Используем 'err' для ошибок
});


// Обёртки для логирования с request ID и контекстом
const logWithReq = (req, level, context, message, data, error) => {
  const logObject = {
    reqId: req?.id, // Берем ID из объекта запроса, если он есть
    context,
    msg: message,
    ...(data && { data }),
    ...(error && { err: { message: error.message, stack: error.stack, details: error.details || error } })
  };
  // Pino v7+ сам добавляет объект в лог
  logger[level](logObject);
};

module.exports = {
  logInfo: (req, context, message, data) => logWithReq(req, 'info', context, message, data),
  logWarn: (req, context, message, data) => logWithReq(req, 'warn', context, message, data),
  logError: (req, context, message, error, data) => logWithReq(req, 'error', context, message, data, error),
  logger, // Экспортируем сам инстанс логгера
};