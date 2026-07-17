import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

const SUPPORTED_EXTENSIONS = new Set([".epub", ".mobi", ".pdf"]);

interface Arguments {
  rootDirectory: string;
  outputDirectory: string;
  matchByAuthor: boolean;
}

interface BookFile {
  fullPath: string;
  extension: string;
  originalTitle: string;
  normalizedTitle: string;
  originalAuthor: string;
  normalizedAuthor: string;
  originalGenre: string;
  normalizedGenre: string;
}

interface BookGroup {
  key: string;
  normalizedTitle: string;
  files: BookFile[];
}

interface BookIdentity {
  title: string;
  author: string;
  genre: string;
}

function printHelp(): void {
  console.log(`
Uso:

  npx tsx deduplicar-libros-ruta.ts <directorio>

Opciones:

  --output <directorio>
      Carpeta donde se generan los informes.
      Por defecto: ./resultado-deduplicacion

  --title-only
      Agrupa únicamente por título normalizado.
      El autor y el género se siguen obteniendo y mostrando desde la ruta.

Estructura esperada:

  <raíz>/<Género>/<Autor>/<Fichero.epub|mobi|pdf>

Ejemplos:

  npx tsx deduplicar-libros-ruta.ts \\
    "/media/emilio/0813F02548FF1BAF"

  npx tsx deduplicar-libros-ruta.ts \\
    "/media/emilio/0813F02548FF1BAF" \\
    --output "./resultado-deduplicacion"

  npx tsx deduplicar-libros-ruta.ts \\
    "/media/emilio/0813F02548FF1BAF" \\
    --title-only
`);
}

function parseArguments(argv: string[]): Arguments {
  let rootDirectory: string | undefined;
  let outputDirectory = path.resolve(process.cwd(), "resultado-deduplicacion");
  let matchByAuthor = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }

    if (argument === "--title-only") {
      matchByAuthor = false;
      continue;
    }

    if (argument === "--output") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Falta el valor de --output.");
      }

      outputDirectory = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Opción desconocida: ${argument}`);
    }

    if (rootDirectory) {
      throw new Error(`Argumento inesperado: ${argument}`);
    }

    rootDirectory = path.resolve(argument);
  }

  if (!rootDirectory) {
    throw new Error("Debes indicar la carpeta que contiene los libros.");
  }

  return {
    rootDirectory,
    outputDirectory,
    matchByAuthor,
  };
}

/**
 * Convierte textos visualmente equivalentes en una misma clave.
 *
 * Ejemplos:
 *   Los Miserables      -> los miserables
 *   Los_Miserables      -> los miserables
 *   ¿Los miserables?    -> los miserables
 *   1.280 almas         -> 1 280 almas
 */
function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " y ")
    .replace(/[_‐‑‒–—―-]+/g, " ")
    .replace(/['’‘`´"“”«»]+/g, " ")
    .replace(/[¿?¡!.,;:()[\]{}<>/\\|*+=~^#@%$€]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es");
}

/**
 * Extrae género, autor y título usando exclusivamente esta estructura:
 *
 *   <raíz>/<Género>/<Autor>/<Fichero>
 *
 * El género y el autor siempre proceden de sus carpetas.
 *
 * Si el fichero EPUB repite al final el mismo autor de la carpeta:
 *
 *   Intriga/John Gardner/007 licencia para matar - John Gardner.epub
 *
 * se elimina únicamente ese sufijo del título.
 */
function extractBookIdentity(
  rootDirectory: string,
  fullPath: string,
): BookIdentity {
  const normalizedRoot = path.resolve(path.normalize(rootDirectory));
  const normalizedFullPath = path.resolve(path.normalize(fullPath));
  const relativePath = path.relative(normalizedRoot, normalizedFullPath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`La ruta queda fuera del directorio raíz: ${fullPath}`);
  }

  const parts = relativePath.split(path.sep).filter(Boolean);

  if (parts.length !== 3) {
    throw new Error(
      `La ruta no tiene la estructura Género/Autor/Fichero: ${relativePath}`,
    );
  }

  const [genrePart, authorPart, filenamePart] = parts;

  const genre = genrePart.trim() || "Sin género";
  const author = authorPart.trim() || "Autor desconocido";
  const extension = path.extname(filenamePart);

  let title = path.basename(filenamePart, extension).trim();

  /*
   * Elimina " - Autor", " – Autor" o " — Autor" solamente cuando
   * el autor final coincide, tras normalizar, con la carpeta del autor.
   */
  const authorSuffixMatch = title.match(/^(.*?)\s+[-–—]\s+(.+)$/u);

  if (authorSuffixMatch) {
    const possibleTitle = authorSuffixMatch[1]?.trim();
    const possibleAuthor = authorSuffixMatch[2]?.trim();

    if (
      possibleTitle &&
      possibleAuthor &&
      normalizeText(possibleAuthor) === normalizeText(author)
    ) {
      title = possibleTitle;
    }
  }

  if (!title) {
    throw new Error(`El fichero no contiene un título válido: ${relativePath}`);
  }

  return {
    title,
    author,
    genre,
  };
}

function escapeTsv(value: unknown): string {
  return String(value ?? "")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function createTsv(headers: string[], rows: unknown[][]): string {
  return `${[
    headers.map(escapeTsv).join("\t"),
    ...rows.map((row) => row.map(escapeTsv).join("\t")),
  ].join("\n")}\n`;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function scanBooks(rootDirectory: string): Promise<{
  books: BookFile[];
  invalidPaths: string[];
}> {
  const books: BookFile[] = [];
  const invalidPaths: string[] = [];

  async function scanDirectory(directoryPath: string): Promise<void> {
    let entries;

    try {
      entries = await fs.readdir(directoryPath, {
        withFileTypes: true,
      });
    } catch (error) {
      console.warn(`No se pudo leer ${directoryPath}:`, error);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLocaleLowerCase("es");

      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        continue;
      }

      try {
        const identity = extractBookIdentity(rootDirectory, fullPath);
        const normalizedTitle = normalizeText(identity.title);
        const normalizedAuthor = normalizeText(identity.author);
        const normalizedGenre = normalizeText(identity.genre);

        if (!normalizedTitle) {
          throw new Error("El título queda vacío después de normalizarlo");
        }

        books.push({
          fullPath: path.normalize(fullPath),
          extension: extension.slice(1),
          originalTitle: identity.title,
          normalizedTitle,
          originalAuthor: identity.author,
          normalizedAuthor: normalizedAuthor || "autor desconocido",
          originalGenre: identity.genre,
          normalizedGenre: normalizedGenre || "sin genero",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        console.warn(`[RUTA IGNORADA] ${message}`);
        invalidPaths.push(`${fullPath}\t${message}`);
      }
    }
  }

  await scanDirectory(rootDirectory);

  return {
    books,
    invalidPaths,
  };
}

function groupBooks(books: BookFile[], matchByAuthor: boolean): BookGroup[] {
  const groups = new Map<string, BookGroup>();

  for (const book of books) {
    /*
     * --title-only solo modifica la clave de agrupación.
     * No elimina ni altera los autores guardados en los ficheros.
     */
    const key = matchByAuthor
      ? `${book.normalizedAuthor}::${book.normalizedTitle}`
      : book.normalizedTitle;

    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.files.push(book);
      continue;
    }

    groups.set(key, {
      key,
      normalizedTitle: book.normalizedTitle,
      files: [book],
    });
  }

  return [...groups.values()].sort((first, second) =>
    first.key.localeCompare(second.key, "es"),
  );
}

function getFormats(group: BookGroup): string[] {
  return [...new Set(group.files.map((file) => file.extension))].sort();
}

function getFilesByExtension(group: BookGroup, extension: string): BookFile[] {
  return group.files.filter((file) => file.extension === extension);
}

function getGroupNormalizedAuthors(group: BookGroup): string {
  const authors = [...new Set(group.files.map((file) => file.normalizedAuthor))]
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second, "es"));

  return authors.join(" / ") || "autor desconocido";
}

function getGroupDisplayAuthors(group: BookGroup): string {
  const authors = [...new Set(group.files.map((file) => file.originalAuthor))]
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second, "es"));

  return authors.join(" / ") || "Autor desconocido";
}

function getGroupGenres(group: BookGroup): string {
  return [...new Set(group.files.map((file) => file.originalGenre))]
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second, "es"))
    .join(" / ");
}

function getGroupDisplayTitle(group: BookGroup): string {
  const preferredFile =
    group.files.find((file) => file.extension === "epub") ??
    group.files.find((file) => file.extension === "mobi") ??
    group.files.find((file) => file.extension === "pdf") ??
    group.files[0];

  return preferredFile?.originalTitle ?? group.normalizedTitle;
}

function createGeneralRows(groups: BookGroup[]): unknown[][] {
  return groups.map((group) => [
    getGroupNormalizedAuthors(group),
    group.normalizedTitle,
    getFormats(group).join(", "),
    group.files.length,
    group.files.map((file) => file.fullPath).join(" | "),
    getGroupDisplayAuthors(group),
    getGroupDisplayTitle(group),
    getGroupGenres(group),
  ]);
}

function createDuplicateRows(groups: BookGroup[]): unknown[][] {
  return groups
    .filter((group) => group.files.length > 1)
    .map((group) => [
      getGroupNormalizedAuthors(group),
      group.normalizedTitle,
      getFormats(group).join(", "),
      group.files.length,
      group.files
        .map((file) => `${file.extension}: ${file.fullPath}`)
        .join(" | "),
      getGroupDisplayAuthors(group),
      getGroupDisplayTitle(group),
      getGroupGenres(group),
    ]);
}

function createNewEpubRows(groups: BookGroup[]): unknown[][] {
  const rows: unknown[][] = [];

  for (const group of groups) {
    const epubFiles = getFilesByExtension(group, "epub");
    const oldFiles = group.files.filter(
      (file) => file.extension === "pdf" || file.extension === "mobi",
    );

    if (epubFiles.length === 0 || oldFiles.length > 0) {
      continue;
    }

    for (const epubFile of epubFiles) {
      rows.push([
        epubFile.normalizedAuthor,
        epubFile.normalizedTitle,
        epubFile.originalAuthor,
        epubFile.originalTitle,
        epubFile.originalGenre,
        epubFile.fullPath,
      ]);
    }
  }

  return rows;
}

function createExistingEpubRows(groups: BookGroup[]): unknown[][] {
  const rows: unknown[][] = [];

  for (const group of groups) {
    const epubFiles = getFilesByExtension(group, "epub");
    const oldFiles = group.files.filter(
      (file) => file.extension === "pdf" || file.extension === "mobi",
    );

    if (epubFiles.length === 0 || oldFiles.length === 0) {
      continue;
    }

    for (const epubFile of epubFiles) {
      rows.push([
        epubFile.normalizedAuthor,
        epubFile.normalizedTitle,
        epubFile.originalAuthor,
        epubFile.originalTitle,
        epubFile.originalGenre,
        epubFile.fullPath,
        oldFiles
          .map((file) => `${file.extension}: ${file.fullPath}`)
          .join(" | "),
      ]);
    }
  }

  return rows;
}

function createOldWithoutEpubRows(groups: BookGroup[]): unknown[][] {
  return groups
    .filter((group) => {
      const formats = new Set(getFormats(group));

      return (
        !formats.has("epub") && (formats.has("pdf") || formats.has("mobi"))
      );
    })
    .map((group) => [
      getGroupNormalizedAuthors(group),
      group.normalizedTitle,
      getFormats(group).join(", "),
      group.files.map((file) => file.fullPath).join(" | "),
      getGroupDisplayAuthors(group),
      getGroupDisplayTitle(group),
      getGroupGenres(group),
    ]);
}

async function writeReport(
  outputDirectory: string,
  filename: string,
  headers: string[],
  rows: unknown[][],
): Promise<void> {
  const outputPath = path.join(outputDirectory, filename);

  await fs.writeFile(outputPath, createTsv(headers, rows), "utf8");

  console.log(`${filename}: ${rows.length} registros`);
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));

  if (!(await directoryExists(args.rootDirectory))) {
    throw new Error(`La carpeta no existe: ${args.rootDirectory}`);
  }

  await fs.mkdir(args.outputDirectory, {
    recursive: true,
  });

  console.log(`Escaneando: ${args.rootDirectory}`);
  console.log("Estructura esperada: Género/Autor/Fichero");
  console.log(
    `Comparación: ${args.matchByAuthor ? "autor + título" : "solo título"}`,
  );

  const { books, invalidPaths } = await scanBooks(args.rootDirectory);
  const groups = groupBooks(books, args.matchByAuthor);

  const duplicateGroups = groups.filter((group) => group.files.length > 1);

  const newEpubGroups = groups.filter((group) => {
    const formats = new Set(getFormats(group));

    return formats.has("epub") && !formats.has("pdf") && !formats.has("mobi");
  });

  const existingEpubGroups = groups.filter((group) => {
    const formats = new Set(getFormats(group));

    return formats.has("epub") && (formats.has("pdf") || formats.has("mobi"));
  });

  await writeReport(
    args.outputDirectory,
    "libros-reales-unicos.tsv",
    [
      "autor_normalizado",
      "titulo_normalizado",
      "formatos",
      "cantidad_archivos",
      "rutas",
      "autor",
      "titulo",
      "generos",
    ],
    createGeneralRows(groups),
  );

  await writeReport(
    args.outputDirectory,
    "duplicados-por-titulo.tsv",
    [
      "autor_normalizado",
      "titulo_normalizado",
      "formatos",
      "cantidad_archivos",
      "rutas",
      "autor",
      "titulo",
      "generos",
    ],
    createDuplicateRows(groups),
  );

  await writeReport(
    args.outputDirectory,
    "epub-nuevos.tsv",
    [
      "autor_normalizado",
      "titulo_normalizado",
      "autor",
      "titulo",
      "genero",
      "ruta_epub",
    ],
    createNewEpubRows(groups),
  );

  await writeReport(
    args.outputDirectory,
    "epub-ya-existentes.tsv",
    [
      "autor_normalizado",
      "titulo_normalizado",
      "autor",
      "titulo",
      "genero",
      "ruta_epub",
      "archivos_anteriores",
    ],
    createExistingEpubRows(groups),
  );

  await writeReport(
    args.outputDirectory,
    "antiguos-sin-epub.tsv",
    [
      "autor_normalizado",
      "titulo_normalizado",
      "formatos",
      "rutas",
      "autor",
      "titulo",
      "generos",
    ],
    createOldWithoutEpubRows(groups),
  );

  await fs.writeFile(
    path.join(args.outputDirectory, "rutas-invalidas.tsv"),
    invalidPaths.length > 0
      ? `ruta\terror\n${invalidPaths.join("\n")}\n`
      : "ruta\terror\n",
    "utf8",
  );

  const summary = [
    `Archivos encontrados: ${books.length}`,
    `Libros reales estimados: ${groups.length}`,
    `Grupos con varios archivos: ${duplicateGroups.length}`,
    `Libros con EPUB nuevo: ${newEpubGroups.length}`,
    `Libros con EPUB y formato anterior: ${existingEpubGroups.length}`,
    `Rutas inválidas ignoradas: ${invalidPaths.length}`,
    `Comparación por autor: ${args.matchByAuthor}`,
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(args.outputDirectory, "resumen.txt"),
    summary,
    "utf8",
  );

  console.log("");
  console.log("════════════════════════════════════════");
  console.log(`Archivos físicos:         ${books.length}`);
  console.log(`Libros reales estimados:  ${groups.length}`);
  console.log(`Grupos repetidos:         ${duplicateGroups.length}`);
  console.log(`EPUB realmente nuevos:    ${newEpubGroups.length}`);
  console.log(`Rutas inválidas ignoradas: ${invalidPaths.length}`);
  console.log(`Informes guardados en:    ${args.outputDirectory}`);
}

run().catch((error: unknown) => {
  console.error(
    "Error:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );

  process.exitCode = 1;
});
