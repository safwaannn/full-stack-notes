const APIFeatures = require('../utils/apiFeatures');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

// Consistent response envelope:
//   { status, [results], data: { [resource]: doc } }
// The resource name is derived from the Model name (lowercase).

const getResourceName = (Model) => Model.modelName.toLowerCase();

exports.deleteOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) return next(new AppError('No document found with that ID.', 404));

    res.status(204).json({
      status: 'success',
      data: null,
    });
  });

exports.updateOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!doc) return next(new AppError('No document found with that ID.', 404));

    const resource = getResourceName(Model);
    res.status(200).json({
      status: 'success',
      data: {
        [resource]: doc,
      },
    });
  });

exports.createOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.create(req.body);

    const resource = getResourceName(Model);
    res.status(201).json({
      status: 'success',
      data: {
        [resource]: doc,
      },
    });
  });

exports.getOne = (Model, popOptions) =>
  catchAsync(async (req, res, next) => {
    let query = Model.findById(req.params.id);
    if (popOptions) query = query.populate(popOptions);
    const doc = await query;

    if (!doc) return next(new AppError('No document found with that ID.', 404));

    const resource = getResourceName(Model);
    res.status(200).json({
      status: 'success',
      data: {
        [resource]: doc,
      },
    });
  });

exports.getAll = (Model) =>
  catchAsync(async (req, res, next) => {
    // Support nested routes: GET /tours/:tourId/reviews
    let filter = {};
    if (req.params.tourId) filter = { tour: req.params.tourId };

    const features = new APIFeatures(Model.find(filter), req.query)
      .filter()
      .sort()
      .limitFields()
      .paginate();
    const doc = await features.query;

    const resource = getResourceName(Model) + 's'; // pluralise naively
    res.status(200).json({
      status: 'success',
      results: doc.length,
      data: {
        [resource]: doc,
      },
    });
  });
