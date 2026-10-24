# ADR 009 — Várias chapas e retalhos no mesmo cálculo

**Status:** aceito (V5.8) · **Plano:** fase 3 (várias chapas) · **Complementa:** ADR 006, 007 e 008

## Contexto

Até a V5.7, um cálculo tinha uma chapa só. Lote maior que a chapa ia para o motor clássico, que punha o que coubesse,
e o resto tinha que ser dividido à mão. Era o item obrigatório número 1 da lista da v6 ("Várias chapas e retalhos no
mesmo job, gastando primeiro os retalhos certos").

O escopo continua só nesting: o estoque fica no sistema de gestão. O Prumo recebe a lista de chapas que pode usar e
decide a ordem e quais peças vão em cada uma.

## Decisão

1. **Estoque na entrada do cálculo:** `stock_full_sheets` (chapas inteiras com as medidas da tela, 0 a 50) e
   `stock_remnants` (`[{width, height, quantity, ref}]`, retângulos; `ref` é o código do retalho no sistema de gestão
   e volta na resposta). A chapa desenhada (DXF ou escolhida no desenho) entra também.
2. **Ordem de uso:** chapa desenhada → retalhos do menor para o maior → chapas inteiras. Retalho em que nenhuma peça
   que falta cabe pela caixa (em algum giro permitido) é pulado sem calcular. Gastar primeiro o menor é a regra de
   chão de fábrica para não deixar retalho pequeno parado; não há medição de que ela seja a melhor em todos os casos.
3. **Chapa a chapa:** cada chapa é um cálculo comum (o mesmo worker, o mesmo validador), só com as peças que faltam, e
   com uma semente diferente. O que não coube passa para a próxima. A orquestração fica em `engine/multiSheet.js`, e
   o servidor a usa quando o estoque tem mais de uma chapa; com uma só, nada muda (mesma resposta de antes).
4. **Chapa que não comporta tudo (lote maior que a chapa), Automático:** "o clássico escolhe, o sparrow encaixa".
   * O motor clássico, com metade do tempo, escolhe quais peças vão nesta chapa (ele foi feito para pôr o máximo).
   * O sparrow reencaixa só essas peças, mais apertadas, e tenta pôr outras nos vãos e na ponta que sobrou
     (rodadas com as peças já colocadas como obstáculos fixos no executável, campo `prumo_sheet.fixed`).
   * Fica o plano que aproveitar mais esta chapa (área das peças); empate segue a regra de sempre. Os dois passam
     pelo validador.
5. **SPARROW forçado com lote maior que a chapa:** só as rodadas do sparrow (grupos do tamanho do espaço livre,
   corte da faixa no comprimento da chapa, peças fixas como obstáculo), em tentativas com sementes diferentes.
6. **Na tela:** bloco "Estoque deste cálculo" no passo 2; abas por chapa acima da mesa; bloco "Conjunto de chapas" à
   direita; "Baixar DXF de todas as chapas" (um arquivo por chapa).

## Por que não "uma faixa só e corta"

A primeira tentativa encaixava todas as peças numa faixa longa da altura da chapa e ficava com as que terminavam
dentro do comprimento, repetindo com as peças já colocadas como obstáculos. Medido: a segunda rodada punha 0 peças.
O sparrow minimiza o comprimento total da faixa e não tem por que encher o começo dela. Rodadas com grupos do tamanho
do espaço livre resolvem isso, mas, sozinhas, perderam do clássico em 2 de 3 casos (mesmo tempo, 30 s):

| Lote (chapa) | Clássico | Só rodadas do sparrow |
|---|---|---|
| trueshape × 4 (1200 × 800) | 79,08% | 77,41% |
| industrial × 3 (1200 × 800) | 84,43% | 75,77% |
| içamento × 12 (180 × 120) | 43,57% | 45,39% |

Por isso o Automático usa a combinação do item 4.

O executável precisou de um ajuste pequeno: a construção inicial do sparrow desistia de alargar a faixa antes de
passar dos obstáculos fixos ("could not construct an initial placement"). O limite agora soma o maior X dos
obstáculos (`PRUMO_OBSTACLE_EXTENT`).

## Medição (bench/multichapa.js, 20 s por chapa, semente 1, 2 threads, Xeon 2,1 GHz)

| Lote | Peças | Motor | Chapas | Aproveitamento do conjunto | Última chapa: comprimento usado | Última chapa: maior retalho |
|---|---|---|---|---|---|---|
| trueshape × 10 (1200 × 800) | 60 | clássico | 4 | 70,83% | 1.178 mm | 0,095 m² |
| | | Automático | 4 | 70,83% | 1.059 mm | 0,102 m² |
| industrial × 6 (1200 × 800) | 36 | clássico | 4 | 59,71% | 346 mm | 0,663 m² |
| | | Automático | 4 | 59,71% | 226 mm | 0,757 m² |
| Modelo 1 × 3 (2000 × 1200) | 66 | clássico | 4 | 42,15% | 796 mm | 1,415 m² |
| | | Automático | **3** | **56,21%** | 1.462 mm | 0,624 m² |
| Modelo 2 × 3 (3000 × 1200) | 261 | clássico | 3 | 69,51% | 2.807 mm | 0,343 m² |
| | | Automático | 3 | 69,51% | 2.742 mm | 0,291 m² |

* Todas as chapas válidas pelo validador independente, nenhuma peça faltando.
* No Modelo 1 × 3, o Automático usou **uma chapa a menos** (o clássico não consegue pôr as 22 peças do Modelo 1
  numa chapa em pouco tempo; o sparrow consegue).
* Nos outros três, o número de chapas foi o mesmo e a diferença ficou na última chapa: comprimento usado menor em
  todos; maior retalho retangular maior em 2 e menor em 1 (Modelo 2). Comprimento menor e retalho maior nem sempre
  andam juntos, porque o retalho é o maior retângulo livre, não a ponta da chapa.
* Arquivo: `bench/results/multichapa_v5.8.0_20s.json`.

## Consequências

- O cálculo de cada chapa não olha as seguintes. Em casos raros, trocar peças entre chapas daria uma chapa a menos;
  otimizar o conjunto inteiro fica para depois.
- Retalhos do estoque são retangulares. Retalho com forma real entra como chapa desenhada (um por cálculo, por
  enquanto).
- O tempo total é o tempo do modo × o número de chapas usadas.
- Com várias chapas, "Parar e manter o melhor" encerra a chapa em curso e não calcula as próximas; as peças delas
  voltam como "faltaram".
