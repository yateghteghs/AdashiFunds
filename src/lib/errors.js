'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  AppError,
  bad: (code, msg, details) => new AppError(400, code, msg, details),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'You do not have permission to do that') => new AppError(403, 'forbidden', msg),
  notFound: (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code, msg) => new AppError(409, code, msg),
};
