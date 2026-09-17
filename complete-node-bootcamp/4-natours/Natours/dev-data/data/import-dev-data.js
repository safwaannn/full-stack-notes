const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Tour = require('./../../models/tourModel');
const User = require('./../../models/userModel');
const Review = require('./../../models/reviewModal');

dotenv.config({ path: './config.env' });

const DB = process.env.DATABASE.replace(
  '<PASSWORD>',
  process.env.DATABASE_PASSWORD,
);

mongoose.connect(DB).then(() => console.log('DB connection successful!'));

// READ JSON FILE
const tours = JSON.parse(fs.readFileSync(`${__dirname}/tours.json`, 'utf-8'));
const users = JSON.parse(fs.readFileSync(`${__dirname}/users.json`, 'utf-8'));
const reviews = JSON.parse(
  fs.readFileSync(`${__dirname}/reviews.json`, 'utf-8'),
);

const toObjectId = (id) => new mongoose.Types.ObjectId(id);

const usersForImport = users.map((user) => ({
  ...user,
  _id: toObjectId(user._id),
}));

const reviewsForImport = reviews.map((review) => ({
  ...review,
  _id: toObjectId(review._id),
  user: toObjectId(review.user),
  tour: toObjectId(review.tour),
}));

// IMPORT DATA INTO DB
const importData = async () => {
  try {
    await Tour.create(tours);
    console.log('Data successfully loaded!');
  } catch (err) {
    console.log(err);
  }
  process.exit();
};

// DELETE ALL DATA FROM DB
const deleteData = async () => {
  try {
    await Tour.deleteMany();
    console.log('Data successfully deleted!');
  } catch (err) {
    console.log(err);
  }
  process.exit();
};

// IMPORT USERS AND REVIEWS INTO DB
const importUsersAndReviews = async () => {
  try {
    await User.collection.insertMany(usersForImport);
    await Review.collection.insertMany(reviewsForImport);
    console.log('Users and reviews successfully loaded!');
  } catch (err) {
    console.log(err);
  }
  process.exit();
};

// DELETE USERS AND REVIEWS FROM DB
const deleteUsersAndReviews = async () => {
  try {
    await Review.deleteMany();
    await User.deleteMany();
    console.log('Users and reviews successfully deleted!');
  } catch (err) {
    console.log(err);
  }
  process.exit();
};

if (process.argv[2] === '--import') {
  importData();
} else if (process.argv[2] === '--delete') {
  deleteData();
} else if (process.argv[2] === '--import-users-reviews') {
  importUsersAndReviews();
} else if (process.argv[2] === '--delete-users-reviews') {
  deleteUsersAndReviews();
}
