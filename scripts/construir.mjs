#!/usr/bin/env node
// Constrói o index.html a partir dos arquivos em notas/*.md.
// Formato esperado de cada nota (gerado por gerar.mjs, editável à mão):
//
//   ---
//   data: 2026-08-07
//   titulo: 7 de agosto de 2026
//   ---
//
//   ## Financeiro
//
//   - **Novidade** — texto do item <!-- NUM-123 -->

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

function escapar(texto) {
  return texto
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function analisarNota(nome, conteudo) {
  const partes = conteudo.split(/^---\s*$/m);
  if (partes.length < 3) throw new Error(`${nome}: front-matter ausente.`);
  const meta = {};
  for (const linha of partes[1].split("\n")) {
    const m = linha.match(/^(\w+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  if (!meta.data || !meta.titulo) throw new Error(`${nome}: front-matter sem data/titulo.`);

  const secoes = [];
  let atual = null;
  for (const linha of partes.slice(2).join("---").split("\n")) {
    const cabecalho = linha.match(/^##\s+(.+)$/);
    if (cabecalho) {
      atual = { modulo: cabecalho[1].trim(), itens: [] };
      secoes.push(atual);
      continue;
    }
    const item = linha.match(/^-\s+\*\*(Novidade|Melhoria|Correção)\*\*\s+—\s+(.+)$/);
    if (item && atual) {
      const texto = item[2].replace(/<!--.*?-->/g, "").trim();
      atual.itens.push({ tipo: item[1], texto });
    }
  }
  return { data: meta.data, titulo: meta.titulo, secoes: secoes.filter((s) => s.itens.length) };
}

const CLASSE_TIPO = { Novidade: "novidade", Melhoria: "melhoria", "Correção": "correcao" };

const notas = readdirSync(join(RAIZ, "notas"))
  .filter((n) => n.endsWith(".md"))
  .map((n) => analisarNota(n, readFileSync(join(RAIZ, "notas", n), "utf8")))
  .filter((n) => n.secoes.length)
  .sort((a, b) => b.data.localeCompare(a.data));

const modulos = [...new Set(notas.flatMap((n) => n.secoes.map((s) => s.modulo)))].sort((a, b) =>
  a === "Plataforma" ? 1 : b === "Plataforma" ? -1 : a.localeCompare(b, "pt-BR")
);

const corpoNotas = notas.length
  ? notas
      .map(
        (nota) => `
      <article class="nota">
        <h2>${escapar(nota.titulo)}</h2>
        ${nota.secoes
          .map(
            (secao) => `
        <section data-modulo="${escapar(secao.modulo)}">
          <h3>${escapar(secao.modulo)}</h3>
          <ul>
            ${secao.itens
              .map(
                (item) =>
                  `<li><span class="selo ${CLASSE_TIPO[item.tipo]}">${item.tipo}</span> ${escapar(item.texto)}</li>`
              )
              .join("\n            ")}
          </ul>
        </section>`
          )
          .join("")}
      </article>`
      )
      .join("\n")
  : `<p class="vazio">As primeiras notas serão publicadas em breve.</p>`;

const filtro = modulos.length
  ? `
    <label class="filtro">Filtrar por módulo
      <select id="filtro-modulo">
        <option value="">Todos os módulos</option>
        ${modulos.map((m) => `<option value="${escapar(m)}">${escapar(m)}</option>`).join("\n        ")}
      </select>
    </label>`
  : "";

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Numih — Notas de atualização</title>
<meta name="description" content="Novidades, melhorias e correções publicadas em produção no sistema Numih.">
<style>
  :root {
    color-scheme: light dark;
    --fundo: #fafafa; --texto: #1a1a1a; --suave: #6b6b6b; --borda: #e4e4e4;
    --novidade-f: #e6f4ea; --novidade-t: #1e6f3e;
    --melhoria-f: #e8f0fe; --melhoria-t: #1a56b0;
    --correcao-f: #fdf3e3; --correcao-t: #8a5a00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fundo: #131313; --texto: #ececec; --suave: #9a9a9a; --borda: #2c2c2c;
      --novidade-f: #12301c; --novidade-t: #7fce9c;
      --melhoria-f: #14233d; --melhoria-t: #8ab2f2;
      --correcao-f: #33270f; --correcao-t: #e2b365;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fundo); color: var(--texto);
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  header h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  header p { color: var(--suave); margin: 0 0 2rem; }
  .filtro { display: block; font-size: .85rem; color: var(--suave); margin-bottom: 2.5rem; }
  .filtro select {
    display: block; margin-top: .35rem; padding: .45rem .6rem; font: inherit;
    color: var(--texto); background: var(--fundo);
    border: 1px solid var(--borda); border-radius: .4rem; min-width: 14rem;
  }
  .nota { border-top: 1px solid var(--borda); padding-top: 1.75rem; margin-top: 1.75rem; }
  .nota:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .nota h2 { font-size: 1.15rem; margin: 0 0 1rem; }
  .nota h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--suave); margin: 1.4rem 0 .5rem; }
  .nota ul { list-style: none; margin: 0; padding: 0; }
  .nota li { padding: .3rem 0; }
  .selo {
    display: inline-block; font-size: .7rem; font-weight: 600; letter-spacing: .03em;
    padding: .1rem .5rem; border-radius: 99px; margin-right: .5rem; vertical-align: .08em;
  }
  .selo.novidade { background: var(--novidade-f); color: var(--novidade-t); }
  .selo.melhoria { background: var(--melhoria-f); color: var(--melhoria-t); }
  .selo.correcao { background: var(--correcao-f); color: var(--correcao-t); }
  .vazio { color: var(--suave); }
  footer { margin-top: 4rem; font-size: .8rem; color: var(--suave); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Notas de atualização</h1>
    <p>Novidades, melhorias e correções publicadas em produção no sistema Numih.</p>
  </header>
  ${filtro}
  ${corpoNotas}
  <footer>© Numih. Atualizado automaticamente a cada publicação em produção.</footer>
</main>
<script>
  const seletor = document.getElementById("filtro-modulo");
  if (seletor) {
    seletor.addEventListener("change", () => {
      const escolhido = seletor.value;
      document.querySelectorAll("section[data-modulo]").forEach((secao) => {
        secao.hidden = escolhido !== "" && secao.dataset.modulo !== escolhido;
      });
      document.querySelectorAll("article.nota").forEach((nota) => {
        nota.hidden = ![...nota.querySelectorAll("section[data-modulo]")].some((s) => !s.hidden);
      });
    });
  }
</script>
</body>
</html>
`;

writeFileSync(join(RAIZ, "index.html"), html);
console.log(`index.html construído (${notas.length} notas, ${modulos.length} módulos).`);
