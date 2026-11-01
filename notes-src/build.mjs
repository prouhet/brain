import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const fonts = [
  ["Barlow", 400, "@fontsource/barlow/files/barlow-latin-400-normal.woff2"],
  ["Barlow", 500, "@fontsource/barlow/files/barlow-latin-500-normal.woff2"],
  ["Barlow", 600, "@fontsource/barlow/files/barlow-latin-600-normal.woff2"],
  ["Barlow Condensed", 500, "@fontsource/barlow-condensed/files/barlow-condensed-latin-500-normal.woff2"],
  ["Barlow Condensed", 600, "@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2"],
  ["Barlow Condensed", 700, "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2"],
];
const fontCss = fonts.map(([fam, w, f]) =>
  `@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${readFileSync("node_modules/" + f).toString("base64")}) format("woff2")}`).join("\n");
const js = await build({ entryPoints: ["src/app.js"], bundle: true, minify: true, format: "iife", target: ["es2020"], write: false, legalComments: "none" });
const css = readFileSync("src/app.css", "utf8");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Studio Strong Notes</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23000'/%3E%3Cpath d='M10 8h9l4 4v12H10z' fill='none' stroke='%2300778B' stroke-width='2.4' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
${fontCss}
${css}
</style>
</head>
<body>
<script>
${js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}
</script>
</body>
</html>
`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/notes.html", html);
console.log("dist/notes.html", (html.length / 1024).toFixed(0), "KB");
