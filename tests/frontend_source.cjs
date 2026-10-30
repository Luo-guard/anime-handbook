const fs = require("fs");
const html = fs.readFileSync("static/index.html", "utf8");
module.exports = [...html.matchAll(/src="(\/modules\/[^"?]+\.js)(?:\?[^" ]*)?"/g)].map(m => fs.readFileSync("static" + m[1], "utf8")).join("\n") + fs.readFileSync("static/app.js", "utf8");
