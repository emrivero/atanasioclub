import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

const sourceFile = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(projectRoot, "libros-reales-unicos.tsv");

const outputFile = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(projectRoot, "data", "books.json");

const FORMAT_PRIORITY = ["epub", "mobi", "pdf"];
const SUPPORTED_FORMATS = new Set(FORMAT_PRIORITY);

function decodeTsvValue(value = "") {
  return value
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .trim();
}

function splitTsvLine(line) {
  return line.split("\t").map(decodeTsvValue);
}

function normalizeFormat(value) {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function getFormatFromPath(filePath) {
  return normalizeFormat(extname(filePath));
}

function splitStoredPaths(value) {
  return value
    .split(/\s+\|\s+/)
    .map((currentPath) => currentPath.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTitle(filename, author) {
  const extension = extname(filename);
  let title = extension ? filename.slice(0, -extension.length) : filename;

  if (author) {
    const authorAtEnd = new RegExp(
      `\\s+[-–—]\\s+${escapeRegExp(author)}$`,
      "iu",
    );

    title = title.replace(authorAtEnd, "");
  }

  return title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function parseBookPath(filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const parts = normalizedPath.split("/").filter(Boolean);

  const filename = parts.at(-1) ?? "";
  const author = parts.at(-2) ?? "Autor desconocido";
  const genre = parts.at(-3) ?? "Sin género";
  const format = getFormatFromPath(filename);

  return {
    path: filePath,
    filename,
    author,
    genre,
    format,
    title: cleanTitle(filename, author),
  };
}

function chooseRepresentativeFile(files) {
  return [...files].sort((first, second) => {
    const firstPriority = FORMAT_PRIORITY.indexOf(first.format);
    const secondPriority = FORMAT_PRIORITY.indexOf(second.format);

    const normalizedFirstPriority = firstPriority === -1 ? 999 : firstPriority;
    const normalizedSecondPriority =
      secondPriority === -1 ? 999 : secondPriority;

    return (
      normalizedFirstPriority - normalizedSecondPriority ||
      first.title.length - second.title.length ||
      first.path.localeCompare(second.path, "es")
    );
  })[0];
}

function mostCommon(values, fallback) {
  const counts = new Map();

  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return (
    [...counts.entries()].sort(
      ([firstValue, firstCount], [secondValue, secondCount]) =>
        secondCount - firstCount || firstValue.localeCompare(secondValue, "es"),
    )[0]?.[0] ?? fallback
  );
}

const source = await readFile(sourceFile, "utf8");
const rawLines = source
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (rawLines.length === 0) {
  throw new Error(`El fichero está vacío: ${sourceFile}`);
}

const firstRow = splitTsvLine(rawLines[0]);
const hasHeader = firstRow.some((column) =>
  [
    "autor_normalizado",
    "titulo_normalizado",
    "formatos",
    "cantidad_archivos",
    "rutas",
  ].includes(column.toLowerCase()),
);

const headers = hasHeader
  ? firstRow.map((header) => header.toLowerCase())
  : [
      "autor_normalizado",
      "titulo_normalizado",
      "formatos",
      "cantidad_archivos",
      "rutas",
    ];

const dataLines = hasHeader ? rawLines.slice(1) : rawLines;

function columnIndex(name, fallbackIndex) {
  const index = headers.indexOf(name);
  return index === -1 ? fallbackIndex : index;
}

const authorIndex = columnIndex("autor_normalizado", 0);
const titleIndex = columnIndex("titulo_normalizado", 1);
const formatsIndex = columnIndex("formatos", 2);
const fileCountIndex = columnIndex("cantidad_archivos", 3);
const pathsIndex = columnIndex("rutas", 4);

const books = [];
let physicalFileCount = 0;

for (const [index, line] of dataLines.entries()) {
  const columns = splitTsvLine(line);
  const normalizedAuthor = columns[authorIndex] ?? "";
  const normalizedTitle = columns[titleIndex] ?? "";
  const storedFormats = (columns[formatsIndex] ?? "")
    .split(",")
    .map(normalizeFormat)
    .filter(Boolean);
  const declaredFileCount = Number(columns[fileCountIndex] ?? 0);
  const storedPaths = splitStoredPaths(columns[pathsIndex] ?? "");

  if (storedPaths.length === 0) {
    console.warn(`Línea ${index + 1} ignorada: no contiene rutas.`);
    continue;
  }

  const files = storedPaths
    .map(parseBookPath)
    .filter((file) => SUPPORTED_FORMATS.has(file.format));

  if (files.length === 0) {
    console.warn(
      `Línea ${index + 1} ignorada: ninguna ruta tiene formato EPUB, MOBI o PDF.`,
    );
    continue;
  }

  const representative = chooseRepresentativeFile(files);
  const formats = [
    ...new Set([
      ...storedFormats.filter((format) => SUPPORTED_FORMATS.has(format)),
      ...files.map((file) => file.format),
    ]),
  ].sort(
    (first, second) =>
      FORMAT_PRIORITY.indexOf(first) - FORMAT_PRIORITY.indexOf(second),
  );

  const genres = [...new Set(files.map((file) => file.genre))].sort((a, b) =>
    a.localeCompare(b, "es"),
  );

  const authors = [...new Set(files.map((file) => file.author))].sort((a, b) =>
    a.localeCompare(b, "es"),
  );

  const title = representative.title || normalizedTitle || "Título desconocido";
  const author = mostCommon(authors, normalizedAuthor || "Autor desconocido");
  const genre = mostCommon(genres, "Sin género");
  const fileCount =
    Number.isFinite(declaredFileCount) && declaredFileCount > 0
      ? declaredFileCount
      : files.length;

  physicalFileCount += fileCount;

  books.push({
    id: books.length + 1,
    title,
    author,
    genre,
    genres,
    formats,
    fileCount,
  });
}

books.sort(
  (first, second) =>
    first.title.localeCompare(second.title, "es", {
      sensitivity: "base",
      numeric: true,
    }) ||
    first.author.localeCompare(second.author, "es", {
      sensitivity: "base",
      numeric: true,
    }),
);

books.forEach((book, index) => {
  book.id = index + 1;
});

const genres = [...new Set(books.flatMap((book) => book.genres))].sort((a, b) =>
  a.localeCompare(b, "es", { sensitivity: "base" }),
);

const formats = FORMAT_PRIORITY.filter((format) =>
  books.some((book) => book.formats.includes(format)),
);

const catalog = {
  generatedAt: new Date().toISOString(),
  count: books.length,
  physicalFileCount,
  genres,
  formats,
  books,
};

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(catalog), "utf8");

console.log(`Origen: ${sourceFile}`);
console.log(`Salida: ${outputFile}`);
console.log(`Libros reales únicos: ${books.length}`);
console.log(`Ficheros físicos representados: ${physicalFileCount}`);
console.log(`Géneros: ${genres.length}`);
