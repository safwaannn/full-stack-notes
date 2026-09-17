const AppError = require('./../utils/appError');

// Handle Mongoose CastError (e.g. invalid ObjectId)
const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

// Handle Mongoose duplicate key error (code 11000)
const handleDuplicateFieldsDB = (err) => {
  // keyValue contains the duplicate field(s) in modern Mongoose / MongoDB driver
  const value = err.keyValue ? Object.values(err.keyValue)[0] : 'unknown';
  const message = `Duplicate field value: "${value}". Please use another value!`;
  return new AppError(message, 400);
};

// Handle Mongoose ValidationError
const handleValidationError = (err) => {
  const errors = Object.values(err.errors).map((el) => el.message);
  const message = `Invalid input data: ${errors.join('. ')}`;
  return new AppError(message, 400);
};

// Handle invalid JWT signature
const handleJWTError = () => new AppError('Invalid token. Please log in again!', 401);

// Handle expired JWT
const handleJWTExpiredError = () =>
  new AppError('Your token has expired. Please log in again!', 401);

const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: err.message,
    stack: err.stack,
  });
};

const sendErrorProd = (err, res) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  } else {
    // Programming or unknown error: don't leak error details
    console.error('ERROR 💥', err);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong!',
    });
  }
};

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(err, res);
  } else if (process.env.NODE_ENV === 'production') {
    let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
    error.message = err.message;

    // CastError — invalid MongoDB ObjectId
    if (error.name === 'CastError') error = handleCastErrorDB(error);
    // Duplicate key error
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);
    // Mongoose validation error
    if (error.name === 'ValidationError') error = handleValidationError(error);
    // JWT invalid signature
    if (error.name === 'JsonWebTokenError') error = handleJWTError();
    // JWT expired
    if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();

    sendErrorProd(error, res);
  } else {
    sendErrorDev(err, res);
  }
};
