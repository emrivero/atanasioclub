1. Copia index.html, app.js y styles.css en la raíz de la web.
2. Copia scripts/build_catalog.mjs sustituyendo el generador anterior.
3. Coloca libros-reales-unicos.tsv en la raíz del proyecto.
4. Ejecuta:

   node scripts/build_catalog.mjs

También puedes indicar rutas explícitas:

   node scripts/build_catalog.mjs /ruta/libros-reales-unicos.tsv /ruta/web/data/books.json

El generador produce data/books.json con una entrada por libro real y un array formats.
