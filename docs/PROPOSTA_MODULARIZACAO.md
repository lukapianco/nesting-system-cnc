# Proposta de modularização

## Diagnóstico medido (V5.2)
| Arquivo | Linhas | Responsabilidades distintas | Problema |
|---|---|---|---|
| `nestingWorker.js` | 1.451 | 8+: cache de rotação, colisão, chapa/âncoras, Part-in-Part, compactação, retalhos, decodificador BLF, otimizador, serialização | Estado **global de módulo** (`params`, `SHEET_W/H`, caches) e **executa ao ser importado** (`runHybridMetaheuristicLoop()` no fim): não dá para testar nem reutilizar peças isoladas |
| `public/app.js` | 964 | estado, rede/SSE, desenho no canvas, DOM, upload, perfis, exportação | `drawSheetNesting` (194 linhas) e `startBackendSseOptimization` (133) concentram regras |
| `cadParser.js` | 840 | leitura DXF, discretização, encadeamento, classificação peça/furo, círculo inscrito, chapa | mistura E/S com geometria |
| `index.js` | 258 | rotas HTTP, fila, SSE, cache de upload | aceitável, mas a fila deveria ser módulo próprio |

Já modulares (bom exemplo a seguir): `camPlanner`, `validator`, `dxfWriter`, `processProfiles`, `jobBuilder`.

## Estrutura alvo
```
src/
  geometry/   primitives · polygon · predicates · rtree · offset · nfp
  io/         dxf-reader · dxf-writer · presets
  engine/     problem-context · rotation-cache · sheet-model · collision · placement(BLF) · holes · compaction
              · remnants · metrics · decoder · optimizer(brkga+sa) · serialize · worker (fino: só conecta)
  cam/        lead-in · sequencing · planner · process-profiles
  validation/ validator
  server/     routes · job-queue · upload-store · sse
  client/     state · api · viewport/renderer · panels · export
test/ bench/ docs/
```
**Regra de dependência:** `engine` recebe um `ProblemContext` (parâmetros, chapa, caches) por **injeção**; nada de globais.
`geometry` não conhece `engine`; `cam` e `validation` só consomem o resultado do `engine`.

## Ordem sugerida (cada passo protegido pela suíte de testes)
1. `ProblemContext` + worker sem efeito colateral no `require`. 2. Extrair `collision`/`holes`/`remnants`. 3. Extrair `optimizer`.
4. Separar `client/` em módulos ES. 5. Mover o que for pesado para o núcleo nativo/WASM (Fase de geometria exata).

## Progresso (V5.3)
* `geometry/primitives.js` — módulo folha com os predicados compartilhados (sem `require` do projeto).
* `geometry/congruence.js` — peças idênticas a menos de rotação.
* `dxf/` — `reader`, `flatten`, `curves`, `heal`, `doctor` (o "io/dxf-reader" da estrutura alvo, já separado em etapas).
* `engine/collision.js` — primeiro módulo extraído do `nestingWorker.js` (passo 2 da ordem sugerida).
* Teste de estrutura (`test/engine_units.js`): grafo de dependências **acíclico**; módulos folha sem dependências; ninguém importa o worker.
