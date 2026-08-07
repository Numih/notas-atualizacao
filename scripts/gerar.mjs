#!/usr/bin/env node
// Gera as notas de atualização a partir das issues em produção no Linear.
//
// Fluxo: lê a marca-d'água em estado.json → busca issues do time Numih no
// estado "Produção" tocadas desde então (o filtro é por `updatedAt`, porque
// `completedAt` não muda na transição Homologado→Produção) → desconta as já
// processadas (publicadas.json) → classifica/redige via OpenRouter → escreve
// notas/*.md → avança a marca-d'água (incondicionalmente, mesmo em semana vazia).
//
// Estados "Homologado" e "Concluído" ficam de fora por decisão: só o que o
// time moveu para "Produção" está, de fato, nas mãos do cliente.
//
// Uso:
//   node scripts/gerar.mjs              # execução semanal (uma nota datada de hoje)
//   node scripts/gerar.mjs --backfill   # agrupa o período acumulado em notas mensais

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUSO = "America/Sao_Paulo";

const LINEAR_API_KEY = obrigatoria("LINEAR_API_KEY");
const OPENROUTER_API_KEY = obrigatoria("OPENROUTER_API_KEY");
const MODELO = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
const BACKFILL = process.argv.includes("--backfill");

function obrigatoria(nome) {
  const valor = process.env[nome];
  if (!valor) {
    console.error(`Variável de ambiente ${nome} não definida.`);
    process.exit(1);
  }
  return valor;
}

// ---------------------------------------------------------------- Linear ---

async function buscarIssuesEmProducao(desde) {
  const query = `
    query($after: String, $filter: IssueFilter) {
      issues(first: 100, after: $after, filter: $filter) {
        nodes {
          identifier
          title
          description
          completedAt
          labels { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  const filter = {
    team: { name: { eq: "Numih" } },
    state: { name: { eq: "Produção" } },
    updatedAt: { gt: desde },
  };

  const issues = [];
  let after = null;
  do {
    const resposta = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: LINEAR_API_KEY,
      },
      body: JSON.stringify({ query, variables: { after, filter } }),
    });
    if (!resposta.ok) {
      throw new Error(`Linear respondeu ${resposta.status}: ${await resposta.text()}`);
    }
    const corpo = await resposta.json();
    if (corpo.errors) {
      throw new Error(`Erro GraphQL do Linear: ${JSON.stringify(corpo.errors)}`);
    }
    const pagina = corpo.data.issues;
    issues.push(...pagina.nodes);
    after = pagina.pageInfo.hasNextPage ? pagina.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

// ---------------------------------------------------- classificação local ---

const MAPA_MODULOS = JSON.parse(readFileSync(join(RAIZ, "modulos.json"), "utf8"));

const TIPO_POR_LABEL = { Bug: "correcao", Feature: "novidade", Improvement: "melhoria" };

// Resolve o módulo pela label de repo. Retorna:
//   { descartar: true }                — todas as labels de repo mapeiam para null
//   { modulo: "Financeiro" }           — mapeamento conhecido
//   { modulo: null, pistas: [...] }    — sem mapeamento; o LLM decide com as pistas
function resolverModulo(labels) {
  const slugs = labels
    .filter((l) => l.startsWith("Numih/"))
    .map((l) => l.slice("Numih/".length));
  if (slugs.length === 0) return { modulo: null, pistas: [] };

  const conhecidos = slugs.filter((s) => s in MAPA_MODULOS);
  const destinos = conhecidos.map((s) => MAPA_MODULOS[s]).filter((d) => d !== null);
  if (destinos.length > 0) return { modulo: destinos[0] };
  const desconhecidos = slugs.filter((s) => !(s in MAPA_MODULOS));
  if (desconhecidos.length === 0) return { descartar: true };
  return { modulo: null, pistas: desconhecidos };
}

function prepararIssues(brutas) {
  const preparadas = [];
  for (const issue of brutas) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const destino = resolverModulo(labels);
    if (destino.descartar) continue;
    const tipoLabel = labels.find((l) => l in TIPO_POR_LABEL);
    preparadas.push({
      id: issue.identifier,
      titulo: issue.title,
      descricao: (issue.description || "").slice(0, 1500),
      concluidaEm: issue.completedAt,
      modulo: destino.modulo,
      pistasDeModulo: destino.pistas || [],
      tipo: tipoLabel ? TIPO_POR_LABEL[tipoLabel] : null,
      agrupadora: labels.includes("grouped"),
    });
  }
  return preparadas;
}

// ------------------------------------------------------------- OpenRouter ---

const DIRETRIZES = readFileSync(join(RAIZ, "redacao.md"), "utf8");

async function redigirItens(issues) {
  const usuario =
    "Issues concluídas no período, em JSON. O campo `modulo` já resolvido deve ser respeitado; " +
    "quando vier null, decida usando `pistasDeModulo` e o conteúdo.\n\n" +
    JSON.stringify(issues, null, 2);

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const resposta = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODELO,
          messages: [
            { role: "system", content: DIRETRIZES },
            { role: "user", content: usuario },
          ],
          temperature: 0.3,
        }),
      });
      if (!resposta.ok) {
        throw new Error(`OpenRouter respondeu ${resposta.status}: ${await resposta.text()}`);
      }
      const corpo = await resposta.json();
      const texto = corpo.choices?.[0]?.message?.content;
      if (!texto) throw new Error(`Resposta sem conteúdo: ${JSON.stringify(corpo).slice(0, 500)}`);
      const json = texto.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      const dados = JSON.parse(json);
      if (!Array.isArray(dados.itens)) throw new Error("JSON sem o campo `itens`.");
      return dados.itens;
    } catch (erro) {
      console.error(`Tentativa ${tentativa}/3 falhou: ${erro.message}`);
      if (tentativa === 3) throw erro;
      await new Promise((r) => setTimeout(r, tentativa * 5000));
    }
  }
}

// ---------------------------------------------------------------- escrita ---

const TIPOS_VALIDOS = { novidade: "Novidade", melhoria: "Melhoria", correcao: "Correção" };

function dataLocal(iso) {
  // AAAA-MM-DD no fuso de São Paulo
  return new Intl.DateTimeFormat("sv-SE", { timeZone: FUSO, dateStyle: "short" }).format(
    new Date(iso)
  );
}

function tituloDataCompleta(iso) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, dateStyle: "long" }).format(
    new Date(iso)
  );
}

function tituloMes(anoMes) {
  const [ano, mes] = anoMes.split("-").map(Number);
  const nome = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(ano, mes - 1, 15))
  );
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${ano}`;
}

function escreverNota(arquivo, data, titulo, itens) {
  const validos = itens.filter((item) => {
    const ok =
      item && typeof item.texto === "string" && item.texto.trim() && item.tipo in TIPOS_VALIDOS;
    if (!ok) console.error(`Item ignorado por formato inválido: ${JSON.stringify(item)}`);
    return ok;
  });
  if (validos.length === 0) return false;

  const porModulo = new Map();
  for (const item of validos) {
    const modulo = (item.modulo || "Plataforma").trim();
    if (!porModulo.has(modulo)) porModulo.set(modulo, []);
    porModulo.get(modulo).push(item);
  }
  // Módulos em ordem alfabética; "Plataforma" sempre por último.
  const modulos = [...porModulo.keys()].sort((a, b) =>
    a === "Plataforma" ? 1 : b === "Plataforma" ? -1 : a.localeCompare(b, "pt-BR")
  );

  let md = `---\ndata: ${data}\ntitulo: ${titulo}\n---\n`;
  for (const modulo of modulos) {
    md += `\n## ${modulo}\n\n`;
    const ordem = { novidade: 0, melhoria: 1, correcao: 2 };
    for (const item of porModulo.get(modulo).sort((a, b) => ordem[a.tipo] - ordem[b.tipo])) {
      const refs = Array.isArray(item.issues) && item.issues.length
        ? ` <!-- ${item.issues.join(", ")} -->`
        : "";
      md += `- **${TIPOS_VALIDOS[item.tipo]}** — ${item.texto.trim()}${refs}\n`;
    }
  }
  const caminho = join(RAIZ, "notas", arquivo);
  if (existsSync(caminho)) {
    console.error(`Aviso: ${arquivo} já existe e será sobrescrito.`);
  }
  writeFileSync(caminho, md);
  console.log(`Nota escrita: notas/${arquivo} (${validos.length} itens)`);
  return true;
}

// ------------------------------------------------------------------ main ---

const estado = JSON.parse(readFileSync(join(RAIZ, "estado.json"), "utf8"));
const caminhoPublicadas = join(RAIZ, "publicadas.json");
const publicadas = new Set(
  existsSync(caminhoPublicadas) ? JSON.parse(readFileSync(caminhoPublicadas, "utf8")) : []
);
const agora = new Date().toISOString();

console.log(`Buscando issues em Produção tocadas desde ${estado.marcaDagua}…`);
const tocadas = await buscarIssuesEmProducao(estado.marcaDagua);
// O filtro por updatedAt também captura issues antigas de Produção que apenas
// receberam um comentário ou label; o registro de processadas as elimina.
const brutas = tocadas.filter((i) => !publicadas.has(i.identifier));
console.log(`${tocadas.length} issues na janela; ${brutas.length} ainda não processadas.`);
const issues = prepararIssues(brutas);
console.log(`${issues.length} candidatas após o de-para de módulos.`);

if (issues.length > 0) {
  if (BACKFILL) {
    const porMes = new Map();
    for (const issue of issues) {
      const mes = dataLocal(issue.concluidaEm).slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes).push(issue);
    }
    for (const mes of [...porMes.keys()].sort()) {
      console.log(`Redigindo ${mes} (${porMes.get(mes).length} issues)…`);
      const itens = await redigirItens(porMes.get(mes));
      // Data = último dia efetivamente coberto, não o último dia do calendário:
      // datar o mês corrente em 31 o colocaria acima de notas semanais mais recentes.
      const ultimaCoberta = porMes
        .get(mes)
        .map((i) => dataLocal(i.concluidaEm))
        .sort()
        .at(-1);
      escreverNota(`${mes}.md`, ultimaCoberta, tituloMes(mes), itens);
    }
  } else {
    console.log("Redigindo a nota da semana…");
    const itens = await redigirItens(issues);
    const hoje = dataLocal(agora);
    escreverNota(`${hoje}.md`, hoje, tituloDataCompleta(agora), itens);
  }
} else {
  console.log("Nada relevante no período; nenhuma nota gerada.");
}

// Toda issue buscada entra no registro — inclusive as descartadas pelo de-para
// ou pelo modelo — para nunca ser reenviada em execuções futuras.
for (const issue of brutas) publicadas.add(issue.identifier);
writeFileSync(caminhoPublicadas, JSON.stringify([...publicadas].sort(), null, 2) + "\n");

// Marca-d'água avança sempre, mesmo em semana vazia — o commit resultante
// mantém o cron do GitHub ativo (repositórios inativos têm o cron suspenso).
writeFileSync(join(RAIZ, "estado.json"), JSON.stringify({ marcaDagua: agora }, null, 2) + "\n");
console.log(`Marca-d'água avançada para ${agora}; registro com ${publicadas.size} issues.`);
