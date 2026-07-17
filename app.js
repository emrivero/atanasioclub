const PAGE_SIZE = 60;
const collator = new Intl.Collator("es", {
  sensitivity: "base",
  numeric: true,
});

const normalize = (value = "") =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const elements = {
  search: document.querySelector("#search"),
  genre: document.querySelector("#genre"),
  sort: document.querySelector("#sort"),
  catalog: document.querySelector("#catalog"),
  results: document.querySelector("#results"),
  clear: document.querySelector("#clear"),
  empty: document.querySelector("#empty"),
  more: document.querySelector("#more"),
  total: document.querySelector("#total"),
  physicalTotal: document.querySelector("#physical-total"),
  template: document.querySelector("#book-template"),
};

let books = [];
let filtered = [];
let visible = PAGE_SIZE;

function createFormatTag(format, files) {
  const tag = document.createElement("span");
  const normalizedFormat = format.toLowerCase();

  tag.className = `format-tag format-tag--${normalizedFormat}`;
  tag.textContent = normalizedFormat.toUpperCase();

  const matchingPaths = files
    .filter((file) => file.format === normalizedFormat)
    .map((file) => file.path);

  if (matchingPaths.length > 0) {
    tag.title = matchingPaths.join("\n");
  }

  return tag;
}

function render() {
  const fragment = document.createDocumentFragment();

  for (const book of filtered.slice(0, visible)) {
    const card = elements.template.content.cloneNode(true);

    card.querySelector(".book-genre").textContent = book.genre;
    card.querySelector(".book-title").textContent = book.title;
    card.querySelector(".book-author").textContent = book.author;

    const formatsContainer = card.querySelector(".book-formats");

    for (const format of book.formats) {
      formatsContainer.append(createFormatTag(format, book.files));
    }

    fragment.append(card);
  }

  elements.catalog.replaceChildren(fragment);
  elements.results.textContent = `${filtered.length.toLocaleString("es-ES")} ${
    filtered.length === 1 ? "libro" : "libros"
  }`;
  elements.empty.hidden = filtered.length !== 0;
  elements.more.hidden = visible >= filtered.length;
  elements.more.textContent = `Mostrar más (${Math.min(
    PAGE_SIZE,
    filtered.length - visible,
  )})`;
}

function applyFilters() {
  const query = normalize(elements.search.value.trim());
  const terms = query.split(/\s+/).filter(Boolean);
  const genre = elements.genre.value;

  filtered = books.filter(
    (book) =>
      (!genre || book.genres.includes(genre)) &&
      terms.every((term) => book.search.includes(term)),
  );

  const field = elements.sort.value;

  filtered.sort(
    (first, second) =>
      collator.compare(first[field], second[field]) ||
      collator.compare(first.title, second.title),
  );

  visible = PAGE_SIZE;
  elements.clear.hidden = !query && !genre;
  render();
}

async function loadCatalog() {
  try {
    const response = await fetch("data/books.json");

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    books = data.books.map((book) => ({
      ...book,
      genres: Array.isArray(book.genres) ? book.genres : [book.genre],
      formats: Array.isArray(book.formats) ? book.formats : [],
      files: Array.isArray(book.files) ? book.files : [],
      search: normalize(
        [
          book.title,
          book.author,
          ...(book.genres ?? [book.genre]),
          ...(book.formats ?? []),
        ].join(" "),
      ),
    }));

    for (const genre of data.genres) {
      elements.genre.add(new Option(genre, genre));
    }

    elements.total.textContent = data.count.toLocaleString("es-ES");

    if (elements.physicalTotal) {
      elements.physicalTotal.textContent = Number(
        data.physicalFileCount ?? data.count,
      ).toLocaleString("es-ES");
    }

    applyFilters();
  } catch (error) {
    elements.results.textContent = "No se pudo cargar el catálogo.";
    elements.empty.hidden = false;
    elements.empty.querySelector("p").textContent =
      "Ejecuta npm run build y abre la web desde un servidor local.";
    console.error(error);
  }
}

let debounce;

elements.search.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 120);
});

elements.genre.addEventListener("change", applyFilters);
elements.sort.addEventListener("change", applyFilters);

elements.more.addEventListener("click", () => {
  visible += PAGE_SIZE;
  render();
});

elements.clear.addEventListener("click", () => {
  elements.search.value = "";
  elements.genre.value = "";
  applyFilters();
  elements.search.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    elements.search.focus();
  }
});

loadCatalog();
