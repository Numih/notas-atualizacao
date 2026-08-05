# Notas de atualização — Numih

Página pública de notas de atualização do sistema Numih, gerada automaticamente a partir das issues concluídas no Linear. Projetada para **zero manutenção**: um cron semanal busca as issues, um modelo de linguagem classifica e redige o texto voltado ao cliente, e o resultado é publicado via GitHub Pages.

## Como funciona

1. **Sexta-feira, 09h (Brasília)** — logo após o deploy de produção de quinta à noite, o workflow [`notas.yml`](.github/workflows/notas.yml) executa `scripts/gerar.mjs`.
2. O script lê a **marca-d'água** em `estado.json` e busca no Linear as issues do time Numih **no estado "Produção"** tocadas desde então (o filtro usa `updatedAt`, porque `completedAt` não muda na transição Homologado→Produção). Issues em "Homologado" ou "Concluído" **nunca entram** — só o que o time moveu para "Produção" está nas mãos do cliente. O registro `publicadas.json` garante que nenhuma issue seja processada duas vezes. Se o cron falhar uma semana, nada se perde: a execução seguinte cobre o período acumulado.
3. As issues passam pelo de-para de módulos (`modulos.json`) e vão ao modelo de linguagem (via OpenRouter), que segue as diretrizes editoriais de [`redacao.md`](redacao.md): descarta ruído técnico e **qualquer issue de segurança**, funde issues correlatas e redige itens de uma linha em português.
4. O resultado vira um arquivo em `notas/` (um por semana; mensal no backfill), `scripts/construir.mjs` reconstrói o `index.html`, e o commit publica tudo pelo GitHub Pages.
5. A marca-d'água avança **mesmo em semana vazia** — o commit resultante mantém o cron ativo (o GitHub suspende crons de repositórios sem atividade por 60 dias).

## Correção de um texto publicado (escotilha)

Edite o arquivo correspondente em `notas/` diretamente no GitHub e faça commit na `main`. O push reconstrói e republica a página automaticamente. O gerador **nunca reescreve notas antigas** — a edição manual é definitiva.

Formato de cada item (o selo e o travessão importam para a renderização):

```markdown
- **Novidade** — Agora é possível estornar baixas em lote. <!-- NUM-123 -->
```

O comentário HTML guarda as issues de origem e **é exibido na página** como referência discreta ao lado de cada item — é o número que o cliente usa para acompanhar um chamado.

## Configuração (uma única vez)

1. **Segredos** em *Settings → Secrets and variables → Actions*:
   - `LINEAR_API_KEY` — chave de API do usuário de serviço do Linear (não usar chave pessoal);
   - `OPENROUTER_API_KEY` — chave do OpenRouter.
2. **GitHub Pages**: *Settings → Pages*, servir da branch `main`, pasta `/ (root)`.
3. **Backfill inicial**: executar o workflow manualmente (*Actions → Notas de atualização → Run workflow*) com a opção **backfill** marcada — gera notas mensais desde a marca-d'água inicial em `estado.json`.
4. **Domínio próprio** (opcional): criar um CNAME `atualizacoes.numih.com → numih.github.io` no DNS e configurá-lo em *Settings → Pages*.

## Dependência de processo

O gatilho de publicação é a issue chegar ao estado **"Produção"** no Linear. Se após o deploy de quinta ninguém (ou nenhuma automação) mover as issues de "Homologado" para "Produção", a nota da sexta sai vazia — e os itens aparecem na semana em que a movimentação acontecer.

## Módulo novo?

Acrescente uma linha em `modulos.json` mapeando a label de repo do Linear (parte após `Numih/`) para o nome exibido na página, `"Plataforma"` (transversal visível) ou `null` (nunca visível ao cliente). Enquanto a linha não existir, o modelo de linguagem decide sozinho — o pipeline não trava.

## Troca de modelo

Edite a variável `OPENROUTER_MODEL` em [`notas.yml`](.github/workflows/notas.yml).
