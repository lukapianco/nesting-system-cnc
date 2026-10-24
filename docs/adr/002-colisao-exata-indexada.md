# ADR 002 — Colisão true-shape exata e indexada; busca de posição por pontuação

**Status:** aceito (V5.3) · **Fase do plano:** 0.1 (modularização: `engine/collision.js`) e pré-requisito de 2.x

## Contexto

Com os DXF reais (peças com 59 a 452 vértices, vindas de arcos e splines), o V5.2 fazia **uma avaliação a cada
12,4 s** (Modelo 1), contra ~3.200/s nos presets de 4–6 vértices. O perfil de CPU mostrou 97% do tempo em
`polygonsCollideTrueShape`: força bruta O(n·m) com 3 testes por par de arestas **mais** ponto-em-polígono de todos os
vértices e pontos médios, para cada um dos ~1.300 candidatos por peça.

## Decisão (sem trocar correção por velocidade)

1. **Fronteiras:** só pares de arestas cujas caixas, expandidas pela folga mínima, se tocam podem colidir
   (cruzar ou ficar a menos da folga). As arestas de A dentro da caixa de B são obtidas numa R-tree de A, e para cada
   uma as vizinhas numa R-tree de B. As R-trees são criadas sob demanda e guardadas por anel (`WeakMap`), e
   os anéis rotacionados já são compartilhados pelo cache de geometria.
2. **Contenção:** se as fronteiras não se cruzam nem se aproximam, um anel está inteiro dentro do outro ou inteiro
   fora. Basta testar **um** vértice de cada lado (antes: todos os vértices e pontos médios).
3. **Busca de posição:** em vez de testar colisão em todos os candidatos e guardar o de menor pontuação, os candidatos
   são pontuados, ordenados de forma **estável** e o primeiro válido vence — o mesmo escolhido pela varredura antiga
   (empates mantêm a ordem original, como o `<` estrito).

## Verificação de equivalência

* **Teste de propriedade** (`test/engine_units.js`): 8.000 pares aleatórios (6 a 400 vértices, folgas de 0,02 a 12 mm,
  sobrepostos/encostados/contidos/afastados), nos dois sentidos — **16.000 respostas idênticas** à implementação de
  força bruta da V5.2, mantida no teste como oráculo.
* **Layouts idênticos**: 12 execuções determinísticas (6 cenários × 2 sementes) produziram exatamente as mesmas
  posições/ângulos antes e depois (`bench/equivalencia.js`).
* Suíte de regressão e validador independente: verdes.

## Dados medidos (mesma máquina, mesma semente, mesmas peças)

| Caso | V5.2 | V5.3 |
|---|---|---|
| Modelo 1 (22 peças, 2000×1200), 120 s de orçamento | 10 avaliações, 12,4 s cada; 1º resultado em 9,7 s | 628 avaliações, 0,19 s cada (**65×**); 1º resultado em 0,5 s |
| Modelo 2 (87 peças de 452 vértices, 3000×1200) | **> 13 min sem concluir a 1ª avaliação** (medição interrompida) | ~1,6 s por avaliação |
| Presets (4–6 vértices) | igual | igual ou até ~20% mais rápido |

## Consequências

* `engine/collision.js` é o primeiro módulo extraído do `nestingWorker.js` (função pura, testada isoladamente).
* O gargalo restante com peças curvas é o **volume de candidatos** do gerador heurístico (não é NFP real). A solução é
  o posicionamento por NFP exato (fase 2.1), não mais atalhos no teste de colisão.
