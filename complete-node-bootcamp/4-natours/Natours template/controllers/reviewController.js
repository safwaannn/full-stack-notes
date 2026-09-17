const factory = require('./factoryHandler.js');
const Review = require('./../models/reviewModal.js');

exports.setTourUserId = (req, res, next) => {
  // Nested route: /tours/:tourId/reviews
  if (!req.body.tour) req.body.tour = req.params.tourId;
  // FIX: was req.params.id — should be logged-in user's id
  if (!req.body.user) req.body.user = req.user.id;
  next();
};

exports.getAllReviews = factory.getAll(Review);
exports.getReview = factory.getOne(Review);
exports.createReview = factory.createOne(Review);
exports.updateReview = factory.updateOne(Review);
exports.deleteReview = factory.deleteOne(Review);
