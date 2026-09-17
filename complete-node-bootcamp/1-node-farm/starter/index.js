// const hello = "Hello World!";
// console.log(hello);
// to read the file.
const fs = require("fs");
const http = require("http");
const url = require("url");
// blocking ,synchronos way
// const testIn = fs.readFileSync("./txt/append.txt", "utf-8");
// console.log(testIn);

// const textOut = `thia is a avocado dtails : ${testIn} \n Created on ${Date.now()}`;
// fs.writeFileSync("./txt/output.txt", textOut);
// console.log("File Created");
// non-blocking ,synchronos way

// fs.readFile("./txt/start.txt", "utf-8", (err, data1) => {
//   fs.readFile(`./txt/${data1}.txt`, "utf-8", (err, data2) => {
//     console.log(data2);
//     fs.readFile(`./txt/append.txt`, "utf-8", (err, data3) => {
//       console.log(data3);
//       fs.writeFile(
//         "./txt/final.txt",
//         `${data2} \n ${data3}`,
//         "utf-8",
//         (err) => {
//           console.log("file has been written");
//         },
//       );
//     });
//   });
// });
// console.log("reading the file");
const replaceTemplate = (temp, product) => {
  let output = temp.replace(/{%PRODUCTNAME%}/g, product.productName);
  output = output.replace(/{%IMAGE%}/g, product.image);
  output = output.replace(/{%PRICE%}/g, product.price);
  output = output.replace(/{%FROM%}/g, product.from); // Make sure your HTML uses {%FROM%}
  output = output.replace(/{%NUTRIENTS%}/g, product.nutrients);
  output = output.replace(/{%QUANTITY%}/g, product.quantity);
  output = output.replace(/{%DESCRIPTION%}/g, product.description);
  output = output.replace(/{%ID%}/g, product.id);

  if (!product.organic) {
    output = output.replace(/{%NOT_ORGANIC%}/g, "not-organic");
  } else {
    output = output.replace(/{%NOT_ORGANIC%}/g, "");
  }

  return output;
};

const tempOverview = fs.readFileSync("./templates/overview.html", "utf-8");
const tempProducts = fs.readFileSync("./templates/product.html", "utf-8");
const tempCard = fs.readFileSync("./templates/template-card.html", "utf-8");

const productsData = fs.readFileSync("./dev-data/data.json", "utf-8");
const dataObj = JSON.parse(productsData);

const server = http.createServer((req, res) => {
  const pathName = req.url;

  if (pathName === "/" || pathName === "/overview") {
    res.writeHead(200, {
      "Content-Type": "text/html",
    });

    const cardsHtml = dataObj
      .map((el) => replaceTemplate(tempCard, el))
      .join("");

    const output = tempOverview.replace("{%PRODUCT_CARDS%}", cardsHtml);

    res.end(output); // <-- Missing
  } else if (pathName === "/product") {
    res.end("this is the Products page");
  } else if (pathName === "/api") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(productsData);
  } else {
    res.writeHead(404, {
      "content-type": "text/html",
      "my-own-header": "hello world",
    });
    res.end(" <h1> Page Not Found </h1>");
  }
});

server.listen(8080, () => {
  console.log("Listnig port on 8001");
});
