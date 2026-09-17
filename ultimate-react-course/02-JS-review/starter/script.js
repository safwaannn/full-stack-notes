const data = [
  {
    id: 1,
    title: "The Lord of the Rings",
    publicationDate: "1954-07-29",
    author: "J. R. R. Tolkien",
    genres: [
      "fantasy",
      "high-fantasy",
      "adventure",
      "fiction",
      "novels",
      "literature",
    ],
    hasMovieAdaptation: true,
    pages: 1216,
    translations: {
      spanish: "El señor de los anillos",
      chinese: "魔戒",
      french: "Le Seigneur des anneaux",
    },
    reviews: {
      goodreads: {
        rating: 4.52,
        ratingsCount: 630994,
        reviewsCount: 13417,
      },
      librarything: {
        rating: 4.53,
        ratingsCount: 47166,
        reviewsCount: 452,
      },
    },
  },
  {
    id: 2,
    title: "The Cyberiad",
    publicationDate: "1965-01-01",
    author: "Stanislaw Lem",
    genres: [
      "science fiction",
      "humor",
      "speculative fiction",
      "short stories",
      "fantasy",
    ],
    hasMovieAdaptation: false,
    pages: 295,
    translations: {},
    reviews: {
      goodreads: {
        rating: 4.16,
        ratingsCount: 11663,
        reviewsCount: 812,
      },
      librarything: {
        rating: 4.13,
        ratingsCount: 2434,
        reviewsCount: 0,
      },
    },
  },
  {
    id: 3,
    title: "Dune",
    publicationDate: "1965-01-01",
    author: "Frank Herbert",
    genres: ["science fiction", "novel", "adventure"],
    hasMovieAdaptation: true,
    pages: 658,
    translations: {
      spanish: "",
    },
    reviews: {
      goodreads: {
        rating: 4.25,
        ratingsCount: 1142893,
        reviewsCount: 49701,
      },
    },
  },
  {
    id: 4,
    title: "Harry Potter and the Philosopher's Stone",
    publicationDate: "1997-06-26",
    author: "J. K. Rowling",
    genres: ["fantasy", "adventure"],
    hasMovieAdaptation: true,
    pages: 223,
    translations: {
      spanish: "Harry Potter y la piedra filosofal",
      korean: "해리 포터와 마법사의 돌",
      bengali: "হ্যারি পটার এন্ড দ্য ফিলোসফার্স স্টোন",
      portuguese: "Harry Potter e a Pedra Filosofal",
    },
    reviews: {
      goodreads: {
        rating: 4.47,
        ratingsCount: 8910059,
        reviewsCount: 140625,
      },
      librarything: {
        rating: 4.29,
        ratingsCount: 120941,
        reviewsCount: 1960,
      },
    },
  },
  {
    id: 5,
    title: "A Game of Thrones",
    publicationDate: "1996-08-01",
    author: "George R. R. Martin",
    genres: ["fantasy", "high-fantasy", "novel", "fantasy fiction"],
    hasMovieAdaptation: true,
    pages: 835,
    translations: {
      korean: "왕좌의 게임",
      polish: "Gra o tron",
      portuguese: "A Guerra dos Tronos",
      spanish: "Juego de tronos",
    },
    reviews: {
      goodreads: {
        rating: 4.44,
        ratingsCount: 2295233,
        reviewsCount: 59058,
      },
      librarything: {
        rating: 4.36,
        ratingsCount: 38358,
        reviewsCount: 1095,
      },
    },
  },
];

function getBooks() {
  return data;
}

function getBook(id) {
  return data.find((d) => d.id === id);
}

// const book = getBook(1);

// const { id, title, publicationDate, author, hasMovieAdaptation, genres } = book;
// book;
///////
/* // destruturing
// const title = book1.title;
// title;

// const author = book1.author;
// author;
// console.log(title, author);

const { title, author, genres } = book1;
console.log(title, author, genres);
title;
// const primaryGenre = genres[0];
// const secondaryGenre = genres[1];
// primaryGenre;
// secondaryGenre;

const [primaryGenre, secondaryGenre] = genres;
console.log(primaryGenre, secondaryGenre); */
///////////////
//spread operator
// const genres = genres;
/*const [primaryGenre, secondaryGenre, ...otherGenres] = genres;
console.log(primaryGenre, secondaryGenre, otherGenres);
genres;

const newGenres = ["funny", ...genres];
newGenres;

const updatedBook = {
  ...book,
  newGenres,
  publicationDate: "2001-12-21",

  pages: 1200,
};
updatedBook;
///////////////////////////////////
// template litrals

const details = `{The book ${book.title}, of ${book.pages}-Pages written by ${book.author} published by ${book.publicationDate} has ${genres[0]} types of genres}`;
details;

// ///////////////////////////////////////
// trenay instead of if else

const pages = `the book ${title} ${
  book.pages > 1000 ? "have more than 1000" : "has less than 1000 "
} pages`;
pages;
// ///////////////////////////////////////////
// arrow funtions
// // old way
// function getYear(str) {
//   return str.split("-")[0];
// }

const getYear = (str) => str.split("-")[0];

console.log(getYear(publicationDate));

const translations = () => book.translations;
console.log(translations());
 */
// /////////////////////////////
// optional chaining

/* reviews: {
  goodreads: {
    rating: 4.52,
    ratingsCount: 630994,
    reviewsCount: 13417,
  },
  librarything: {
    rating: 4.53,
    ratingsCount: 47166,
    reviewsCount: 452,
  },
 */
const book = getBook(3);
/*

const getTotalReviewCount = function () {
  const goodreads = book?.reviews?.goodreads?.reviewsCount ?? 0;
  const librarything = book?.reviews?.librarything?.ratingsCount ?? 0;

  return goodreads + librarything;
};
console.log(getTotalReviewCount()) */
/////////////////////////////////////////////
// array map method
const books = getBooks();

const x = [1, 2, 3, 4].map((el) => el * 2);
x;
const title = books.map((book) => book.title);
title;

const pagesAllBooks = books
  .filter((book) => book.pages > 500)
  .map((book) => book.hasMovieAdaptation);
pagesAllBooks;

const sumOfAllPages = books.reduce((acc, book) => acc + book.pages, 0);
sumOfAllPages;
