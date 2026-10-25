# Diário de bordo — Prumo (motor de nesting)

Registro do que foi feito, por quê e como foi verificado. Base para o relatório do PROMPT 2.

## Sessão V5.9 — passo 3: sequência de corte e tempo de máquina

Pedido: com o ok do usuário, fazer o tempo de máquina como passo 3 (o CAM sem máquina virou o passo 4), sem dados
de máquina por enquanto; registrar antes no plano.

### Decisões
* Melhorar a sequência de corte (vale para qualquer plano) em vez de só escolher entre planos.
* Tempo estimado com três valores editáveis, marcados como ponto de partida.
* O objetivo "menos tempo de máquina" não foi para a tela depois de medido (efeito desprezível).

### Erros meus nesta sessão (corrigidos antes da entrega)
* O primeiro bench de CAM saiu todo com o motor clássico: o harness de teste fixa o clássico por padrão e eu não
  passei o motor. Refeito com o Automático.
* A primeira versão da escolha de entradas por programação dinâmica não olhava perfurações próximas demais; no
  içamento ela juntava perfurações. Agora a sequência nova só vale se não piorar isso.
* Uma penalidade maior para G00 sobre peça solta (200 e 600 mm) foi testada: reduz mais esse G00, mas alonga o
  caminho em alguns casos; ficou a de 60 mm, que melhora os dois.

### Verificação
* `npm test` com e sem o executável; `test/ui_e2e.js` com o executável.
* `bench/cam.js --time 15` (antes × depois nos mesmos layouts) e o comparativo de objetivos.

## Sessão V5.8 — várias chapas e retalhos, threads pela medição do usuário, painel direito

Pedido: registrar o arquivo do teste de paralelismo (i5-12400, 12 threads); seguir para o passo 2 (várias chapas e
retalhos no mesmo cálculo); deixar a barra direita no mesmo estilo da esquerda.

### Decisões
* Threads: buscas de 3 threads, pela medição do usuário (ADR 008, revisão).
* Várias chapas: chapa a chapa, retalhos do menor para o maior antes das chapas inteiras (ADR 009).
* Chapa que não comporta tudo: "o clássico escolhe, o sparrow encaixa", depois de medir que as rodadas só do sparrow
  perdiam do clássico em 2 de 3 casos.

### Erros meus nesta sessão (corrigidos antes da entrega)
* A primeira versão do lote maior que a chapa encaixava tudo numa faixa e cortava no comprimento da chapa; a rodada de
  reabastecimento seguinte punha 0 peças (o sparrow só encurta a faixa, não enche o começo dela). Troquei por rodadas
  com grupos do tamanho do espaço livre.
* As rodadas falhavam com "could not construct an initial placement": a construção inicial do sparrow tinha um limite
  de largura que não contava os obstáculos fixos. Ajustado no executável.
* Rodadas gastas tentando uma peça grande de cada vez (todas as cópias falhavam do mesmo jeito). Agora, quando nada
  coube, saem juntas as cópias e as peças maiores.
* Com tudo isso, as rodadas ainda perdiam do clássico em 2 de 3 casos; daí a combinação com o clássico. O comentário
  do código dizia "nunca fica abaixo do clássico", o que só vale para o plano do clássico que ela mesma calcula (com
  metade do tempo); corrigido o texto e o teste mede exatamente isso.
* A cor do furo útil ocupado da V5.7 ficava verde-água (amarelo transparente sobre o azul da peça). Visto na captura
  da tela; corrigido.

### Verificação
* `npm test` com e sem o executável; `test/ui_e2e.js` com o executável.
* `bench/multichapa.js` com 4 lotes, clássico × Automático, 20 s por chapa (ADR 009).

## Sessão V5.7 — buscas em paralelo, resultado reproduzível, retorno do usuário

Pedido: começar pelo passo 1 combinado (várias sementes em paralelo e resultado igual por semente); o usuário tem
6 núcleos e 12 threads para testar; corrigir a cor do furo útil quando tem peça dentro e criar cor para furo sem
aproveitamento; melhorar o contraste do trilho da esquerda; o teste de cancelamento falhou no Windows (`ps`); registrar
no plano a coleta dos dados de CAM.

### Decisões
* Buscas independentes em processos separados (não threads dentro de uma busca só), porque cada busca já é
  determinística sozinha e a melhor entre elas se escolhe sem depender de qual terminou antes. ADR 008.
* Orçamento em passos contados na thread principal do sparrow. A compressão usava o relógio: trocado pela fração de
  passos só no modo de passos.
* Modo reproduzível com divisão fixa (2 × 2): reproduzível tem que valer em qualquer servidor, então a divisão não
  pode depender da máquina.

### Erros meus nesta sessão (corrigidos antes da entrega)
* A primeira versão do orçamento em passos não era reproduzível: a compressão do sparrow decide o tamanho do
  encolhimento pelo tempo decorrido. Achado ao rodar a mesma semente preso a 1 núcleo e ver outro plano.
* O teste de interface novo clicou em "Calcular de novo" com o cálculo rodando (botão desabilitado). Agora para antes.
* Testei a junta em quina para a margem de segurança e a deixei no código antes de ter dados suficientes; com 2
  sementes por variante a diferença ficou dentro do ruído, então desfiz.

### Verificação
* `npm test` com e sem o executável; `test/ui_e2e.js` 16/16 com e sem o executável.
* Reprodutibilidade conferida no executável (livre e preso a 1 núcleo, 1 e 2 threads) e no teste do motor.
* `bench/paralelo.js` com 2 threads nesta máquina; a rodada de 12 threads fica com o usuário.

## Sessão V5.6 — chapa desenhada no sparrow, interface nova, cálculo antigo parado

Pedido: seguir para a próxima fase e, em paralelo, redesenhar a interface sem "cara de IA"; o painel do servidor não
atualizava; conferir se mudar a entrada no meio de um cálculo para o anterior; tirar o laboratório de OS da fase 4
(a integração será com os softwares da empresa); dizer o que falta nas funções de CAM, como subir os pontos do
benchmark, o que a v6 precisa ter e como fazer um benchmark público; olhar dois DXF novos (Modelo 2 sem moldura e
Modelo 3).

### Decisões
* Próxima fase = chapa irregular no sparrow (o caso mais comum numa sobra e o primeiro "fora do alcance" da ADR 006).
  Os obstáculos usam a zona de qualidade 0 que o jagua-rs já tinha; o que faltava era a perda proporcional no
  sparrow. ADR 007.
* O Modelo 3 mostrou um caso novo: a chapa usada desenhada junto com as peças. O Doctor só **sugere**; o usuário
  escolhe. Critério e falso positivo medido no CHANGELOG.
* Interface redesenhada direto no código, sem mock-up separado, porque o usuário pediu em paralelo e liberou mexer no
  layout. Todos os ids antigos ficaram.
* Fase 4 do plano reescrita: o Prumo fala só com a API principal da empresa (rede privada, chave de serviço), jobs
  assíncronos com webhook, contrato v1, idempotência. Nada de laboratório de OS.

### Erros meus nesta sessão (corrigidos antes da entrega)
* Furos da chapa sumiam no offset: anéis em sentido horário encolhem quando inflados pelo Clipper. Achado porque
  todas as soluções do industrial em `sheet_ramp_hole` foram reprovadas pelo validador ("encosta em furo"); agora o
  sentido é corrigido antes do offset.
* A primeira correção do cancelamento matava o processo filho direto e deixava zumbis. Trocado por cancelamento pelo
  próprio worker, com prazo; o teste conta processos vivos e zumbis.
* O redesenho tirou o nome do arquivo do cabeçalho do diagnóstico e o teste de interface parou de achar o arquivo;
  a faixa da moldura também lia o nome de lá. Os dois voltaram a usar o nome guardado.
* Etiquetas de retalho se sobrepunham e nomes de peça ficavam embaixo das peças filhas. Etiqueta só quando cabe, nomes
  desenhados por último.
* O teste de "mudar a chapa para o cálculo antigo" passava sem provar nada (aceitava qualquer status). Agora confere
  que abriu exatamente um cálculo novo e que o número de cálculos rodando não subiu.

### Verificação
* `npm test` com o executável: 23 + 35 + 5 + 14, sem falhas. Sem o executável: 23 + 35 + 5 + 3 (o Automático
  cai no clássico e os testes que dependem do sparrow são pulados).
* `test/ui_e2e.js`: 15/15 com e sem o executável; nenhum `prumo-sparrow` sobrando depois.
* Corpus de DXF com mutações: 653 arquivos, 0 travamentos, 0 erros internos.
* Benchmark longo (300 s, 2 threads) em 4 instâncias: resultado no CHANGELOG e no plano.

## Sessão V5.5 — otimizador sparrow (fases 2 e 3) e corpus público de DXF (fase 1)

Pedido: seguir para a próxima fase do roteiro, com o estudo de repositórios trazido pelo usuário (sparrow, jagua-rs,
Clipper2, ezdxf, LibreDWG, libnest2d, Deepnest/SVGnest). DXF de clientes vão demorar, então a fase 1 avança com
arquivos públicos. Pergunta do usuário: como subir os pontos percentuais do benchmark e o que isso muda no projeto.

### Ambiente
* O registro de crates (index.crates.io, static.crates.io) estava bloqueado: 403 no proxy. O GitHub não estava.
  As 30 dependências do otimizador foram baixadas das tags oficiais no GitHub e ligadas com `[patch.crates-io]` num
  arquivo de configuração fora do repositório.
* Para compilar sem rede, a cópia local do `rand` ficou sem os recursos opcionais `getrandom`/`chacha20`. O código do
  Prumo não depende disso: o `Cargo.toml` versionado é o normal e compila com `cargo build` comum (o CI faz isso).
* CPU desta sessão: Xeon 2,1 GHz com 2 threads (a V5.4 mediu num Xeon 2,8 GHz). Por isso o benchmark do motor
  clássico foi refeito aqui, para comparar os dois motores no mesmo hardware.

### Decisões
* Usar o sparrow como processo externo, sem mudar o algoritmo. Folga, furos, Part-in-Part, retalhos, CAM e validação
  continuam no Prumo. Detalhes na ADR 006.
* O motor padrão é o **Automático**. A escolha veio da medição: benchmark público e chapas reais (CHANGELOG V5.5).

### Erros meus nesta sessão (corrigidos antes da entrega)
* No teste novo, o leitor ingênuo de DXF contava o ponto (0,0) do cabeçalho da `POLYLINE` como vértice e dava peças a
  mais. Corrigido para ler só os `VERTEX`; o erro era do teste, não da exportação.
* A primeira tabela do benchmark com sparrow saiu com "0 avaliações" e o paralelismo errado. Isso foi corrigido no
  gerador da tabela (`--rebuild` agora preserva os metadados da rodada original), sem rodar o benchmark de novo.
* A V5.4 dizia que o repositório do sparrow era MPL-2.0. É MIT, e a MPL é do jagua-rs. Corrigido no CHANGELOG, na
  ADR 005 e no script.

### Verificação
* `npm test` passou sem o executável (o Automático cai no clássico) e com ele:

  | Suíte | Resultado |
  |---|---|
  | `test/run.js` | 23/23 |
  | `test/dxf_doctor.js` | 33/33 |
  | `test/engine_units.js` | 5/5 |
  | `test/engine_sparrow.js` | 10/10 com o executável; 3/3 sem |

* `test/ui_e2e.js`: 11/11, com e sem o executável.
* Benchmark público: os dois motores, 65/65 válidas cada.
* `bench/motores.js`: 30/30 layouts válidos.
* Corpus de DXF: 653 arquivos, 0 travamentos, 0 erros internos.

## Sessão V5.4 — exportação lida errado pelo laboratório de OS + próximos passos do plano

Pedido: "as peças do `exemplo_icamento.dxf` não estão separadas adequadamente no DXF de *Exportar .DXF p/ Máquina CNC*"
(o laboratório de OS mostrava 1 peça 180×120 com 4 furos + 2 círculos e "6 contorno(s) não fecharam"); "também botar em
prática os próximos passos" e um plano para depois.

### Diagnóstico (medido, não suposto)
* Escrevi um **leitor ingênuo** (contenção par/ímpar, sem camadas — o comportamento típico de um sistema de rastreio) e
  reli a exportação padrão da V5.3: deu exatamente o que o usuário viu. Causas: contorno da chapa envolvendo tudo,
  retalhos fechados, lead-ins abertos (6 = 2 olhais + 2 buchas + 2 furos Ø25). Detalhe e decisão: ADR 004.
* O mesmo exercício revelou dois bugs do motor (retalho invadindo peça; retalho atravessando furo de chapa irregular) e
  um do leitor (placa com peça aninhada vista como moldura na ida e volta do `industrial`).
* O benchmark público (folga 0) revelou dois bugs de colisão invisíveis com as folgas dos presets (ADR 005).

### O que mudou
Ver CHANGELOG V5.4. Arquivos: `dxfWriter.js`, `dxf/doctor.js`, `nestingWorker.js`, `engine/collision.js`, `validator.js`,
`typesAndInterfaces.js`, `index.js`, `public/index.html`, `public/app.js`, `package.json`; novos
`docs/FORMATO_DXF_EXPORTADO.md`, ADR 004 e 005, `bench/public/` (script de download + medidor), `.github/workflows/ci.yml`.
Testes: `test/dxf_doctor.js` (27 → 32), `test/engine_units.js` (4 → 5), `test/run.js`, `test/ui_e2e.js`.

### Erros meus nesta sessão (corrigidos antes da entrega)
* Uma edição por script no `nestingWorker.js` usou uma âncora de texto que não era única e apagou código do worker
  ("SHEET_W is not defined", 17 testes vermelhos). Restaurei o arquivo do git e reapliquei todas as edições com
  verificação de unicidade da âncora. Lição: edição automática só com âncora verificada.
* Primeira rodada do benchmark contaminada (sobreposições de 0,002 mm na folga 0, conferência de área estreita demais
  para o arredondamento de coordenadas). Os números dela **não** são usados; só os da rodada depois das correções.
* Teste de camadas esperava 7 contornos; com `EIXO`/`AUX` reconhecidas como auxiliares por nome o certo é 5 — o teste
  passou a cobrir também o `forceLayers` (volta a 7).
* `.gitignore` com `bench/public/instances/` (barra no fim) não ignora um link simbólico; corrigido.

### Verificação
* Ida e volta da exportação (`icamento`, `industrial`, `trueshape`) com leitor ingênuo e com o leitor do Prumo; 25/25
  execuções de estresse com melhor layout e elite aprovados; `bench/equivalencia.js` 12/12 idênticos com folgas usuais.
* Benchmark público: 65 execuções (13 instâncias × 5 sementes × 60 s), resultado no CHANGELOG e em `bench/public/results/`.
* Saídas de `npm test` e `npm run test:ui` registradas na entrega.

## Sessão V5.3 — leitura robusta de DXF (pedido: "esses dois DXF dão erro no motor")

### Ambiente
* O registro npm e o PyPI estavam bloqueados neste ambiente; o GitHub não. As dependências (express 5, multer 2,
  dxf-parser 1.1.2 e transitivas, 75 pacotes) foram reconstruídas a partir das tags no GitHub, nas versões exatas do
  `package-lock.json`; os pacotes publicados como TypeScript (path-to-regexp, content-type, content-disposition,
  dxf-parser) foram transpilados com o strip de tipos do Node 22. `jsdom` e `ezdxf` não puderam ser instalados:
  `test/client_smoke.js` se auto-ignora e o `test/ezdxf_check.py` não rodou. Em compensação a interface foi testada no
  **Chromium real** (Playwright pré-instalado) — `test/ui_e2e.js`.
* Suíte do V5.2 rodada antes de qualquer mudança: 23/23 verde (baseline commitado).

### Diagnóstico (medido)
1. V5.2 nos arquivos: Modelo 1 → 1 contorno (moldura); Modelo 2 → 0 contornos. Causa: `INSERT` ignorado.
2. Estrutura dos arquivos: matrizes associativas (`*U` anônimos) com até 3 níveis, giros 90/180/270, blocos `A$C…` de
   copiar/colar não inseridos (no Modelo 2, inclusive os da chapa de flanges e os rótulos de material), molduras
   desenhadas como polilinha (fechada no Modelo 1; duas abertas no Modelo 2), `$INSUNITS = 4` (mm).
3. Avisos "circular dependency" do terminal: **não reproduzidos** no pacote V5.2 recebido (grafo estático sem ciclo;
   worker roda limpo). Os 3 nomes do aviso são exatamente o que o `nestingWorker.js` importa do `nfpEngine.js`, então na
   cópia local do usuário algo na cadeia do `nfpEngine` importa o `nestingWorker` de volta. Correção estrutural: módulo
   folha `geometry/primitives.js`, `nfpEngine` sem importar o `cadParser`, e um **teste que falha se surgir ciclo**.

### Arquivos criados
| Arquivo | Por quê |
|---|---|
| `dxf/reader.js`, `dxf/flatten.js`, `dxf/curves.js`, `dxf/heal.js`, `dxf/doctor.js` | DXF Doctor (ADR 001) |
| `geometry/primitives.js` | predicados compartilhados num módulo folha (sem ciclos) |
| `geometry/congruence.js` | cópias idênticas → quantidade |
| `engine/collision.js` | colisão exata indexada, extraída do worker (ADR 002) |
| `test/dxf_doctor.js`, `test/dxfSynth.js`, `test/engine_units.js`, `test/ui_e2e.js`, `test/fixtures/*.dxf` | testes |
| `bench/equivalencia.js` | prova de que otimizações não mudam layouts |
| `docs/adr/001…003`, `docs/DIARIO_DE_BORDO.md`, `.gitignore` | decisões e registro |

### Arquivos alterados
| Arquivo | Mudança |
|---|---|
| `cadParser.js` | usa o DXF Doctor; classificação usa a árvore de contenção robusta; `groupIdenticalParts`, `buildCatalogFromDxf`; extrator antigo (que ignorava blocos) removido; API antiga mantida onde usada |
| `jobBuilder.js` | opções de importação por job; quantidade padrão = cópias do desenho |
| `index.js` | leitor próprio, `report`/`frames`/`suggestedSheet` no upload, `/api/reanalyze-dxf`, `/api/stop/:jobId`, erros 422 |
| `nestingWorker.js` | colisão via `engine/collision`, busca por pontuação ordenada, parada cooperativa (`SharedArrayBuffer`) |
| `nfpEngine.js`, `camPlanner.js` | importam predicados de `geometry/primitives` (não do `cadParser`) |
| `presets.js` | cabeçalho com `$INSUNITS = 4` |
| `public/index.html`, `app.js`, `style.css` | painel Diagnóstico do DXF, opções de importação/layers, faixa de moldura, quantidades detectadas, botão Parar |
| `test/harness.js`, `bench/ab.js` | leitor próprio; `qty` multiplica as cópias do desenho |
| `package.json`, `package-lock.json` | 5.3.0; `dxf-parser` → devDependency; scripts de teste |
| `docs/Manual_…` (renomeado sem "V5.2") | cap. 2, 3 (reescrito), 5.9, 12, 14 |

### Erros meus nesta sessão (corrigidos antes da entrega)
* 1º critério de moldura (ocupação ≥ 15%) classificava a placa do preset `industrial` como moldura. Critério refeito
  (forma de peça × forma de furo, sinais fortes) e teste de regressão adicionado.
* Rotação das cópias relativa a um representante girado a 37° (a ordenação por caixa escolhia a cópia "torta"). Agora
  o representante é a cópia com a menor caixa alinhada (melhor para os giros 0/90/180/270 do motor).
* "Oito" simétrico (área líquida zero) era relatado como "área nula" em vez de auto-interseção.
* `node_modules` entrou no primeiro commit; corrigido com `.gitignore`.

### Verificação final
Ver CHANGELOG (V5.3) e a saída de `npm test` / `npm run test:ui` registrada na entrega.
