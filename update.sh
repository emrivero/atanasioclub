npx tsx dedup.ts /media/emilio/0813F02548FF1BAF;

cp ./resultado-deduplicacion/libros-reales-unicos.tsv ./libros-reales-unicos.tsv;

node scripts/build_catalog.mjs;

git add data/books.json;

git commit -m "new version";

git push origin master;