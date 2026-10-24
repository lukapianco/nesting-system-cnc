# V5.5 — otimizador sparrow integrado (fases 2 e 3), corpus público de DXF (fase 1)

## Otimizador sparrow como motor padrão — ADR 006
* O **sparrow 0.3.0** (MIT) com o **jagua-rs 1.1.0** (MPL-2.0) foi compilado num executável próprio,
  `native/prumo-sparrow`, sem mudar o algoritmo. O código-fonte completo e a lista do que mudou estão em
  `PRUMO_MODIFICACOES.md`. O Prumo chama o executável como processo separado (`engine/sparrowBridge.js`).
* **Folga:** aplicada pelo Prumo com **Clipper2** (offset com junta redonda, 4 casas): cada peça é inflada por
  `D_nom/2 + 0,005 mm`.
* **Furos e Part-in-Part:** voltam pelo Prumo, com a mesma transformação da peça mãe.
* **Retalhos, CAM e validação:** são os mesmos do motor clássico.
* **Motor na tela:** **Automático** (padrão), **Otimizador sparrow** ou **Clássico**. O Automático cai no clássico, e
  avisa por quê, quando:
  * o executável não está instalado;
  * a chapa é desenhada (irregular);
  * o lote não cabe numa chapa;
  * nenhuma solução passa no validador.
* **Tempo de busca:** o modo de qualidade vira tempo (10 s / 30 s / 120 s), e o *Tempo Máx.* manda se estiver preenchido.
* **Parar e manter o melhor:** funciona. Se o servidor cai, o otimizador também para (fim do stdin).
* **Compilar:** `npm run build:sparrow` (Rust ≥ 1.90). Sem o executável, nada quebra.

### Benchmark público (mesmo hardware e protocolo da ADR 005; 60 s, 5 sementes, 1 thread por execução, Xeon 2,1 GHz)
| Instância | Clássico: média % | Sparrow: média % | Sparrow: melhor % | Referência publicada % | Distância do melhor (pp) |
|---|---|---|---|---|---|
| albano | 68,81 | 87,98 | 88,08 | 89,821 | 1,74 |
| blaz1 | 57,8 | 80,97 | 81,91 | 86,224 | 4,31 |
| dagli | 58,37 | 86,75 | 87,49 | 90,172 | 2,68 |
| fu | 70,33 | 89,48 | 90,13 | 92,396 | 2,26 |
| jakobs1 | 66,38 | 87,66 | 88,92 | 89,247 | 0,33 |
| jakobs2 | 60,15 | 80,25 | 80,4 | 87,717 | 7,32 |
| mao | 71,75 | 83,19 | 84,29 | 86,867 | 2,57 |
| marques | 66,32 | 89,19 | 89,58 | 92,015 | 2,44 |
| shapes0 | 37,92 ¹ | 65,64 | 66,44 | 69,998 | 3,55 |
| shapes1 | 37,75 ¹ | 71,58 | 72,37 | 76,719 | 4,35 |
| shirts | 52,14 | 86,58 | 87,37 | 90,92 | 3,55 |
| swim | 52,22 | 74,32 | 75,28 | 79,826 | 4,54 |
| trousers | 55,16 | 89,83 | 90,22 | 92,615 | 2,4 |

¹ faixa de 4× (a de 2,5× não comportou todas as peças; ver ADR 005).
**65 de 65 soluções válidas nos dois motores.** A distância para a referência caiu de 15–39 pontos (clássico) para
0,3–7,3 pontos. As referências foram obtidas com 1.200 s e 3 threads num Ryzen 9 7950X (logs do sparrow); aqui foram
60 s e 1 thread.

### Chapas reais, mesmo tempo (`bench/motores.js`; régua de retalhos independente)
| Caso (10 s, 3 sementes) | Motor | Válidos | Todas as peças | Comprimento usado médio (mm) | Maior retalho médio (m²) |
|---|---|---|---|---|---|
| trueshape ×1, 1200×800 | clássico | 3/3 | sim | 1088,6 | 0,412 |
| trueshape ×1, 1200×800 | sparrow | 3/3 | sim | 426,2 | 0,614 |
| industrial ×1, 1200×800 | clássico | 3/3 | sim | 982,2 | 0,391 |
| industrial ×1, 1200×800 | sparrow | 3/3 | sim | 622,2 | 0,458 |
| icamento ×8, 500×300 | clássico | 3/3 | sim | 306,8 | 0,060 |
| icamento ×8, 500×300 | sparrow | 3/3 | sim | 224,2 | 0,081 |
| Modelo 1 (22 peças), 2000×1200 | clássico | 3/3 | não (19/22) | 1921,6 | 0,178 |
| Modelo 1 (22 peças), 2000×1200 | sparrow | 3/3 | sim | 1729,1 | 0,318 |
| Modelo 2 (87 gomos), 3000×1200 | clássico | 3/3 | sim | 2908,2 | 0,078 |
| Modelo 2 (87 gomos), 3000×1200 | sparrow | 3/3 | sim | 2939,7 | 0,008 |

* **Modelo 1:** o clássico não pôs as 22 peças em 10 s; o sparrow pôs.
* **Modelo 2:** 87 peças com splines é o caso pesado. Em 10 s (modo Rascunho) o sparrow perde. Com 30 s (modo Padrão,
  semente 1), ganha:

  | Motor | Comprimento usado | Maior retalho |
  |---|---|---|
  | sparrow | 2.882,8 mm | 0,134 m² |
  | clássico | 2.908,2 mm | 0,078 m² |

  Com 60 s o sparrow chega a 2.874,3 mm.

## Leitura de DXF (fase 1, parte que não depende dos DXF de clientes)
* **Corpus público** (`bench/dxf-corpus`): 228 DXF de exemplo do ezdxf, dxf-parser e dxf-viewer, baixados e não
  redistribuídos. Mais 425 variantes truncadas (25/50/75%) e corrompidas: **653 arquivos, 0 travamentos, 0 erros
  internos**. Todo arquivo ou é lido ou é recusado com motivo (o 422 da API). O mais lento levou 0,9 s.
* **Achado e corrigido:** conteúdo depois de `0 EOF` fazia o arquivo ser recusado como "corrompido". Agora é ignorado,
  com o aviso `TRAILING_DATA`, como faz o AutoCAD. O caso tem teste.
* O CI roda o corpus, com as mutações, a cada envio.

## Outros
* README novo, `THIRD_PARTY_NOTICES.md`, manual (5.9 e limitações).
* Correção: a V5.4 atribuía a licença MPL-2.0 ao repositório do sparrow. O sparrow é MIT; a MPL é do jagua-rs.
* CI: testes com e sem o sparrow; benchmark curto nos dois motores; corpus de DXF.

## Testes
* `test/engine_sparrow.js` (10, novo):
  * Part-in-Part;
  * fibra;
  * parada;
  * reserva para o clássico;
  * exportação relida por um leitor ingênuo.
* `test/dxf_doctor.js`: 33.
* `test/ui_e2e.js`: 11.
* `test/run.js` e `test/engine_units.js`: inalterados. Rodam com o motor clássico fixado no harness, então seguem
  reproduzíveis por semente.

# V5.4 — Prumo: exportação que outros sistemas leem igual, retalhos honestos, benchmark público

O motor passa a se chamar **Prumo** (pacote `prumo`, título da bancada, manual `docs/Manual_Prumo.md`).

## Exportação DXF (relato: laboratório de OS lia o `exemplo_icamento` exportado como "1 peça 180×120 com 4 furos + 2 círculos" e "6 contornos não fecharam") — ADR 004
* Reproduzido com um leitor ingênuo (contenção par/ímpar, sem camadas): o contorno da chapa envolvia tudo (a chapa virava
  a peça, as peças viravam furos), os retalhos eram retângulos fechados e os 6 lead-ins eram linhas abertas.
* **Padrão agora = só geometria de corte** (`1_CORTE_PECAS`, `1_PECA_IN_HOLE`, `2_CORTE_FUROS`). Chapa, retalhos, lead-ins
  e nomes das peças (`5_TEXTO_PECAS`, novo) são opções na tela, cada um na sua camada.
  Mesmo arquivo, mesmo leitor ingênuo: **4 peças** (2 olhais com o furo Ø25 + 2 buchas), 0 contornos abertos.
* Novo **Baixar .DXF dos retalhos** (`POST /api/export-remnants-dxf`): um retângulo + texto por retalho, para estoque.
* Contrato para sistemas consumidores: `docs/FORMATO_DXF_EXPORTADO.md` (camadas, papéis, como ler).
* Leitor do Prumo reconhece as próprias camadas (chapa = moldura, mesmo irregular; retalhos e furos de chapa relatados,
  não viram peças; lead-in e texto = auxiliares) e nomes usuais de camadas auxiliares (cota, dim, texto, hachura, eixo,
  centro, construção, carimbo, legenda…). `forceLayers` traz qualquer camada de volta.

## Bugs do motor encontrados no caminho (corrigidos, com teste)
* **Retalho invadia peça** (1,5 mm² no `exemplo_icamento`): a caixa de bloqueio tinha folga só à direita/acima e o
  arredondamento empurrava a borda para dentro. Agora folga em todos os lados, comparação exata e arredondamento para dentro.
* **Retalho atravessava furo de chapa irregular** (`sheet_ramp_hole`): teste exato segmento × retângulo (Liang–Barsky).
* **Validador independente** reprova retalho sobre peça, a menos de D_nom de peça, ou sobre furo da chapa.
* **Placa com peça aninhada lida como moldura** na ida e volta do preset `industrial`: critério de moldura refinado.
* **Folga 0** (achados pelo benchmark, invisíveis com as folgas dos presets — ADR 005): atalho por caixas da colisão
  inconsistente com o teste exato (micro-sobreposições de 0,002–0,004 mm) e consulta de vizinhos na R-tree perdendo a peça
  encostada por erro de ponto flutuante (`133,32 + 199,98 < 333,3`). Os 12 layouts de referência com folgas usuais seguem
  **idênticos** (`bench/equivalencia.js`).

## Plano em prática
* **Corte de linha comum desligado** na tela e no motor (`common_line_cutting` sempre `false`; o pedido fica em
  `common_line_requested`): a função anunciada não fundia arestas de verdade. Volta quando existir (plano, fase 5).
* **CI** (`.github/workflows/ci.yml`): `npm test`, teste de interface (Chromium) e benchmark público curto com `--strict`.
* **Benchmark público** (`bench/public/`, ADR 005): 13 instâncias ESICUP via repositório do sparrow (MIT; baixadas, não
  redistribuídas), objetivo novo `MIN_STRIP_LENGTH`, densidade e validade medidas fora do motor.

### Ponto de partida medido (60 s, 5 sementes, 2 em paralelo, Xeon 2,8 GHz)
| Instância | Rotações | Peças | Válidas | Média % | Melhor % | Desvio | Referência sparrow % | Distância (melhor) pp |
|---|---|---|---|---|---|---|---|---|
| albano | GRAIN_X | 8 tipos / 24 | 5/5 | 68,81 | 70,76 | 1,49 | 89,821 | 19,07 |
| blaz1 | GRAIN_X | 7 tipos / 28 | 5/5 | 57,8 | 58,97 | 0,88 | 86,224 | 27,25 |
| dagli | GRAIN_X | 10 tipos / 30 | 5/5 | 58,37 | 58,87 | 0,58 | 90,172 | 31,3 |
| fu | ORTHOGONAL | 12 tipos / 12 | 5/5 | 70,33 | 72,61 | 1,79 | 92,396 | 19,79 |
| jakobs1 | ORTHOGONAL | 25 tipos / 25 | 5/5 | 65,57 | 69,2 | 2,11 | 89,247 | 20,05 |
| jakobs2 | ORTHOGONAL | 25 tipos / 25 | 5/5 | 60,15 | 60,5 | 0,35 | 87,717 | 27,21 |
| mao | ORTHOGONAL | 9 tipos / 20 | 5/5 | 71,75 | 72,07 | 0,23 | 86,867 | 14,8 |
| marques | ORTHOGONAL | 8 tipos / 24 | 5/5 | 66,32 | 68,35 | 1,31 | 92,015 | 23,67 |
| shapes0 | FIXED_0 | 4 tipos / 43 | 5/5 | 37,92 | 39,28 | 1,03 | 69,998 | 30,72 (faixa 4×) |
| shapes1 | GRAIN_X | 4 tipos / 43 | 5/5 | 37,67 | 39,44 | 1,12 | 76,719 | 37,28 (faixa 4×) |
| shirts | GRAIN_X | 8 tipos / 99 | 5/5 | 51,8 | 53,62 | 1,3 | 90,92 | 37,3 |
| swim | GRAIN_X | 10 tipos / 48 | 5/5 | 52 | 52,6 | 0,66 | 79,826 | 27,22 |
| trousers | GRAIN_X | 17 tipos / 64 | 5/5 | 55,16 | 58,11 | 2,16 | 92,615 | 34,51 |

Leitura honesta: **65 de 65 soluções válidas**, mas longe das referências (melhor resultado publicado pelo sparrow, com
orçamentos muito maiores). O posicionamento atual (candidatos heurísticos + BLF) é o limite; o caminho está no plano
(núcleo exato/NFP, busca por minimização de sobreposição, multi-start paralelo). Em `shapes0`/`shapes1` a faixa de 2,5×
não comportou todas as peças; com 4× todas couberam e a densidade caiu (~41% parcial → ~38%): a busca atual depende da
largura disponível, outro sintoma do mesmo limite.

## Testes
`test/dxf_doctor.js` **32** (ida e volta da exportação com leitor ingênuo e com o leitor do Prumo, DXF de retalhos,
validador × retalho), `test/engine_units.js` **5** (oráculo com folgas 0–12 mm; regressão "folga 0"), `test/run.js` 23,
`test/ui_e2e.js` (+1: o DXF baixado pela tela só tem camadas de corte; "Incluir chapa" acrescenta `0_CHAPA_LIMITE`).


# V5.3 — DXF Doctor (leitura robusta de DXF reais) + colisão exata indexada

Motivação: dois DXF reais (`test/fixtures/Modelo_1_c_moldura.dxf`, `Modelo_2_c_moldura.dxf`, AutoCAD 2018) "davam erro".
Medido no V5.2: Modelo 1 → **1 contorno** (só a moldura 2000×1200, tratada como peça); Modelo 2 → **0 contornos**.
Causa: o leitor ignorava **blocos** (`INSERT`) — as peças estavam em matrizes associativas (3 níveis de blocos) — e não
sabia que o retângulo em volta das peças era a **chapa** desenhada.

## Leitura de DXF ("DXF Doctor", pasta `dxf/`, sem dependências) — ADR 001
* Blocos aninhados, matrizes (ARRAY/MINSERT), blocos dinâmicos, espelho, giro, ponto base, OCS/extrusão (0,0,−1).
* ELLIPSE, SPLINE (controle e só ajuste), LWPOLYLINE/POLYLINE com bulge, POLYLINE 3D; flecha garantida em todas.
* Unidades `$INSUNITS` → mm (aviso quando ausente; unidade forçável). Code page/UTF-8, `\U+XXXX`, vírgula decimal, CR.
* Layers congeladas/desligadas/não plotáveis/Defpoints e linhas tracejadas tratadas como auxiliares (opções para incluir).
* Costura por grafo de extremidades; fechamento de aberturas até 1 mm (relatado com posição); duplicatas removidas.
* **Moldura** detectada (critério documentado) → não vira peça; a chapa é ajustada para ela (com desfazer).
* **Cópias idênticas** (qualquer giro) → 1 peça × N; quantidades já preenchidas. Espelhos apontados, não agrupados.
* **Relatório** no upload (`report`): severidades, coordenadas, layers, molduras, blocos não usados (ex.: no Modelo 2, o
  bloco "AISI 304 #1/2" 2x1,2m - 2 Fl. Passantes 8 Fl. Cego" existe no arquivo mas **não está inserido** no desenho).
* DWG/DXF binário/PDF recusados com instrução; erros de arquivo = HTTP **422** (antes 500).
* `POST /api/reanalyze-dxf`: muda opções de importação sem reenviar o arquivo.

Resultado nos DXF reais: Modelo 1 → moldura 2000×1200 + `sd`×8, `b`×8, `xscd`×6 (22 peças); Modelo 2 → moldura 3000×1200
+ 1 gomo × 87. Ambos passam pelo motor com layout **aprovado** pelo validador independente.

## Motor — ADR 002 e 003
* `engine/collision.js` (extraído do worker): colisão true-shape **exata** com R-tree de arestas e teste de contenção por
  1 vértice; busca de posição por pontuação ordenada (mesma escolha). **Mesmos layouts** (12/12 idênticos) e mesmas
  respostas da força bruta em 16.000 casos aleatórios. Modelo 1: **12,4 s → 0,19 s por avaliação (65×)**; Modelo 2: V5.2 passou de
  13 min sem concluir a 1ª avaliação (medição interrompida) → V5.3 ~1,6 s por avaliação.
* **Parar e manter o melhor** (`POST /api/stop/:jobId`, botão na tela): encerra ao fim da avaliação em curso e entrega o
  melhor layout validado.

## Estrutura e testes
* `geometry/primitives.js` (módulo folha): predicados que `cadParser`, `nfpEngine`, `camPlanner` e o worker compartilham.
  `nfpEngine` não importa mais o `cadParser`. Teste novo garante **grafo de `require` sem ciclos** (a classe de problema dos
  avisos "Accessing non-existent property … inside circular dependency") e que ninguém importa o `nestingWorker`.
* Testes: `test/run.js` (23), **`test/dxf_doctor.js` (27)**, **`test/engine_units.js` (4)**, `test/client_smoke.js` (jsdom),
  **`test/ui_e2e.js`** (Chromium/Playwright, opcional: `npm run test:ui`, 9 verificações). `bench/equivalencia.js`.
* `dxf-parser` virou devDependency (só para conferir, de forma independente, o DXF que exportamos).

## Limitações conhecidas desta versão
* O posicionamento ainda é por candidatos heurísticos (não NFP exato). Com peças curvas o custo por avaliação é maior
  (Modelo 2: ~1,6 s); no Modelo 1 o motor aloca 19–20 das 22 peças em 2000×1200 com D_nom 6 mm, enquanto o desenho original
  usa 5,7 mm entre peças e 5 mm da moldura. Próximo passo do plano: NFP exato (fase 1.1/2.1).
* Detecção de moldura é heurística: casos ambíguos geram aviso e o usuário decide.

---

# Motor de Nesting — V5.2 (qualidade primeiro)

Regra de negócio adotada: **qualidade, precisão e ferramentas > velocidade**. Velocidade vira *orçamento escolhido pelo usuário*
(modo Rascunho/Padrão/Produção + tempo máximo), nunca uma troca por correção.

## Diagnóstico das imagens (V5.0 × V5.1)
Medido com régua raster independente (`bench/`), mesmas peças, mesmas chapas:

| Cenário | KPI V5.0 | KPI V5.1/5.2 | Retalho útil (régua) V5.0 → V5.1 | Conclusão |
|---|---|---|---|---|
| A) trueshape 1200×800 | 99,61% | ~85% | 644.088 → 644.944 mm² | **Layouts equivalentes**; só o número mudou |
| B) industrial + chapa 1072×544 | 81,45% | 70,3% | 0 → 0 | Nenhum retalho útil em nenhuma versão |
| D) industrial ×2 em 1300×800 (12 peças) | 95,9% | ~83% | 115.792 → 123.692–130.250 mm² | **V5.1 recupera mais retalho** |

Causa: a V5.0 contava como "usada" a área *bruta* da mãe (incluindo o furo) **e** a da filha dentro dele, e listava como retalho
faixas abaixo do mínimo (ex.: 314×44 com mínimo 100). A V5.1 usa área líquida e respeita o mínimo.
Amostras pequenas (2–3 sementes): a diferença entre variantes de configuração está no ruído.

## Novo na V5.2
* **CAM:** perfuração em **sucata aberta primeiro** (alma estreita só sem alternativa; contador na tela); **Or-opt** sobre a ordem das peças
  (G00 do kit industrial: 2.809 → 2.291 mm; cruzamentos 3 → 1); espaçamento entre crateras; folga de borda.
* **Modos de qualidade** (Rascunho / Padrão / Produção / Manual), `evaluation_mode` **PRECISE** por padrão, **limite de tempo** que mantém o melhor layout.
* **Perfis de processo × espessura** (laser fibra/CO₂, plasma, oxicorte, jato d'água, router): `/api/recommend-params`. Pontos de partida, não dados de fabricante.
* `angle_gene_strictness` (0,3): o gene de rotação restritivo da V5.1 era mais agressivo que o ideal.
* KPIs na tela: aproveitamento líquido, maior retalho útil, pierces em alma estreita.
* **Manual** de operação e implantação (`docs/`), proposta de modularização, benchmark A/B (`bench/`).
* Testes: 23 de motor + 7 de cliente, incluindo cruzamento do KPI do motor com a régua independente.

---

# V5.1 (Fase 0: confiabilidade)

Rodar: `npm install && npm run dev` → http://localhost:3000 · Testes: `npm test` (19 + 7 verificações) ·
Verificador independente do DXF (opcional): `pip install ezdxf && python3 test/ezdxf_check.py arquivo.dxf`

## Bugs reportados
| Bug | Causa | Correção |
|---|---|---|
| DXF não abre (AutoCAD / outro app; `linha 543 "ENDSEC"`) | O exportador juntava vértices e entidades **sem quebra de linha** (`join('')`), quebrando os pares código/valor | Novo `dxfWriter.js` (R12/AC1009, POLYLINE/VERTEX, tabelas LTYPE/LAYER, CRLF). Validado no ezdxf (auditoria sem erros) e no dxf-parser |
| Elites de nestings anteriores aparecendo | (1) o histórico de elites nunca era limpo ao iniciar; (2) `activeEventSource` só era atribuído *depois* do `await fetch`, então duas chamadas seguidas deixavam **dois streams vivos** | Token de execução (`runToken`), reset de elites/solução/canvas ao iniciar, mensagens de execuções antigas descartadas, debounce de 400 ms nos botões de quantidade |
| Pierce / Lead-in inadequados | Só havia perfuração no contorno externo (furos sem), na 1ª aresta do polígono, **sem validar** nada; ordem = ordem de alocação; G00 em zigue-zague por cima das peças | Novo `camPlanner.js` (ver abaixo) |

## Bug encontrado por mim (não reportado) — severo
**As peças saíam espelhadas no DXF.** O motor trabalha em Y-para-cima (como o DXF de entrada), mas o exportador fazia `H − y`. Uma cantoneira em "L" saía invertida (área assinada −600 em vez de +600). Agora o viewport desenha em Y-para-cima e a exportação não inverte nada.

## CAM (`camPlanner.js`)
- Perfuração para **todo** contorno: furos (dentro da sucata do furo), filhas In-Hole e contornos externos.
- Lead-in em **arco tangente** (padrão), reta 45° ou reta 90°; cai para o próximo tipo / comprimento menor se não houver espaço.
- Cada perfuração é validada: dentro da chapa (a ≥ min(3, margem/2) mm da borda), **em sucata** (nunca sobre material), folga das demais peças (raio da cratera + kerf/2), longe da própria aresta, e a ≥ 2R+1 mm das outras crateras.
- Sequência Inside-Out **peça a peça** com vizinho mais próximo; G00 que passa por cima de peça já solta é penalizado e reportado (aviso laranja).
- Parâmetros novos: *Tipo de Lead-in*, *Cratera Pierce (mm)*.

## Part-in-Part (hole filling)
- Encaixe por **forma real** (não por caixa): uma bucha 18×18 já não "cabe" num furo Ø25 (a diagonal 25,5 invadia a parede). Cache por tipo de peça.
- Parâmetro novo `Folga Furo→Peça` (padrão 2,0 mm), separado do `part_clearance`. Resolve o ponto 7.2 #1 sem o risco da correção sugerida no dossiê.
- A filha respeita a fibra (`GRAIN_X/Y`); antes girava 90° mesmo com fibra travada.
- Filha de mãe não alocada vai para "não alocadas" (antes **sumia**); IDs de furo por cópia (antes, com quantidade > 1, o cache usava os da 1ª cópia e filhas sumiam/duplicavam).

## Motor
- `usedArea` usa **área líquida** (contorno − furos); antes a mãe contava o furo como aproveitado.
- Metropolis com ΔE normalizado (pontos percentuais) — antes comparava mm² com T≈5 e nunca aceitava piora.
- BRKGA real: população elite, cruzamento uniforme (70%), gene de rotação **restritivo** (antes só desempatava), troca de cópias idênticas evitada.
- Retalhos: modo rápido no laço, varredura fina só para candidatos promissores (ponto 7.2 #2).
- Predicado de orientação: filtro de ponto flutuante com limite de erro e fallback BigInt exato. O BigInt era **69%** do tempo do worker.
- Tolerâncias de colisão: `gap − 0.15` → `gap − 0.01` (antes a ponte podia ficar 0,15 mm menor que a pedida).
- Tolerância de flecha respeitada (clamp de 0,05 rad removido) e aplicada a **cada job** (o campo da UI era inerte).
- NURBS com de Boor correto; splines só com *fit points* interpoladas; correntes abertas não viram mais peças.

## Validação independente (`validator.js`)
Não reusa nenhum predicado do motor. Verifica peças perdidas/duplicadas, sobreposição, folga D_nom, margem e obstáculos da chapa, filhas dentro do furo (com folga), rotação permitida e perfuração em sucata. Roda em todo layout enviado; **layout reprovado bloqueia a exportação** (HTTP 422).

## Servidor
Upload em cache (`uploadId`, TTL 1 h) em vez de reenviar contornos; limite de 30 MB; fila `pendingJobs` com TTL; máx. 3 jobs/IP; heartbeat SSE + `X-Accel-Buffering: no`; payload SSE enxuto; export DXF no servidor (`POST /api/export-dxf`).

## Medido (mesma máquina, sem GPU)
| Cenário | Antes (sua captura) | Agora |
|---|---|---|
| Retangular 180×120, 15.000 aval. | 16,3 s · 919/s | 4,7 s · ~3.200/s |
| Chapa DXF rampa 2012×691 | ~32/s | ~270/s |

## Limitações conhecidas (próximas etapas)
- O "NFP" continua sendo gerador heurístico de candidatos, não Minkowski real (Fase 1: Clipper2).
- Uma única chapa; uma filha por furo; `common_line_cutting` só reduz a folga (não funde arestas — **não use em produção**).
- Chapa customizada ainda ~270/s: gargalo agora é `isPartInsideSheetIfp` (O(vértices × arestas da chapa) por candidato).
- DXF de entrada: ainda ignora `INSERT` (blocos), `ELLIPSE`, layers e `$INSUNITS`.
- Círculos/arcos saem facetados no DXF (a flecha 0,03 mm é respeitada, mas não são ARC/CIRCLE reais).
- Lead-out, microjuntas e G-code não existem; `Dossie_Completo_Handoff` descreve o V5.0 e está desatualizado em relação a este pacote.
- O `app.js` só tem teste de fumaça em jsdom (sem navegador real); a orientação visual foi conferida por renderização do JSON do worker.
