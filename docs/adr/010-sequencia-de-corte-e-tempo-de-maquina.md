# ADR 010 — Sequência de corte e tempo de máquina estimado

**Status:** aceito (V5.9) · **Plano:** passo 3 combinado em 24/10 (tempo de máquina), item obrigatório da v6
("objetivo de corte") · **Complementa:** ADR 004 (CAM no DXF)

## Contexto

A lista da v6 pede que o Prumo cuide do tempo de máquina, não só da chapa: comprimento de corte, perfurações e
deslocamentos em vazio (G00). O planejador de CAM já fazia ordem de dentro para fora, vizinho mais próximo e
Or-opt sobre a ordem das peças, mas escolhia o ponto de entrada de cada contorno olhando só a chegada. Como o corte
de um contorno termina onde começou, a saída ficava onde calhasse, muitas vezes do lado errado da peça recém-solta:
no Modelo 2, 69 dos 87 deslocamentos passavam por cima de peça já cortada.

Não havia dado de máquina para converter nada em segundos: as tabelas de corte (blocos 4 e 5 da coleta) ainda não
chegaram.

## Decisão

1. **Ordem inicial por várias estratégias:** além do vizinho mais próximo a partir da origem, "serpentina" por
   colunas e por linhas com 2, 3, 4, 6 e 8 faixas (a cabeça anda numa direção e não volta sobre o que cortou). Fica
   a de menor custo real (comprimento de G00 + 60 mm de penalidade por G00 sobre peça solta), e o Or-opt de sempre
   continua a partir dela.
2. **Ponto de entrada pela ida e pela volta:** com a ordem decidida, a entrada de cada contorno é escolhida por
   programação dinâmica sobre os candidatos (até 6 por contorno), minimizando o caminho inteiro. É a melhor escolha
   possível para aquela ordem. Só é aceita se não aumentar perfurações próximas demais (calor) nem entradas sem
   espaço; senão fica a sequência anterior.
3. **Tempo de máquina estimado:** corte (contornos + entradas) ÷ velocidade de corte, perfurações × tempo por
   perfuração, G00 ÷ velocidade em vazio. Padrões 3.000 mm/min, 1 s e 20.000 mm/min, marcados como **ponto de
   partida, não dado de fabricante**; a tela tem os três campos (passo 3, "Tempo de máquina (estimativa)"). Não conta
   aceleração, cantos nem troca de chapa.
4. **Objetivo "menos tempo de máquina"** (`optimization_goal: MIN_MACHINE_TIME`) existe na API: entre planos com as
   mesmas peças e a mesma área, escolhe o de menor tempo estimado. **Não foi para a tela**, porque a medição mostrou
   efeito desprezível (abaixo).

## Medição

**Sequência, mesmos layouts, planejador da V5.8 × V5.9** (`bench/cam.js --time 15`; layouts do Automático):

| Layout | G00 antes | G00 agora | G00 sobre peça solta antes | agora |
|---|---|---|---|---|
| trueshape × 3 (17 peças) | 3,54 m | 3,34 m | 10 | 7 |
| industrial × 2 (12) | 4,62 m | 4,00 m | 9 | 7 |
| içamento × 8 (32) | 1,31 m | 1,24 m | 25 | 23 |
| Modelo 1 (22) | 4,76 m | 4,11 m | 12 | 7 |
| Modelo 2 (87 gomos) | 17,09 m | 15,81 m | 69 | 27 |
| Modelo 3 (12 anéis, chapa usada) | 6,20 m | 4,62 m | 7 | 1 |

G00 de 5% a 25% menor e, principalmente, muito menos deslocamento sobre peça já solta (risco de bater em peça
tombada). O número de perfurações não muda: continua uma por contorno. O planejamento leva de 36 a 166 ms.

**Para onde vai o tempo** (valores de partida acima, layouts do sparrow): o corte é 91% a 95% do tempo (69% no içamento,
com muitas peças pequenas); perfurações, 3% a 6% (29% no içamento); G00, 1,5% a 3%. Ou seja: encurtar o G00 em 20% economiza
menos de 1% do tempo total. Com as tabelas reais isso muda (perfuração de plasma em chapa grossa leva vários
segundos), por isso os valores ficam editáveis.

**Objetivo "menos tempo de máquina" × "mais material aproveitado"** (sparrow, 15 s, semente 1,
`bench/results/objetivo_tempo_v5.9.0_15s.json`): diferença de −0,8 a +1,9 s em 168 a 738 s (às vezes
o objetivo de tempo saiu até mais lento, porque cada rodada com tempo é uma busca diferente). Com as mesmas peças, o
corte e as perfurações são iguais em qualquer plano, e o G00 que sobra para escolher é pequeno. Um controle na tela
que não muda nada só confundiria.

## Consequências

- O ganho real de tempo de máquina está em **cortar menos**: linha comum (duas peças retas lado a lado cortadas
  numa passada só) e corte em cadeia (várias peças com uma perfuração). Os dois mudam o desenho do corte e precisam
  de validação em máquina; ficam para o passo de CAM, com a tabela de corte e o corte de teste.
- Quando as tabelas de corte chegarem, só os três valores mudam; o planejador não.
- A estimativa aparece por chapa ("Tempo de máquina (estimativa)") e no total do conjunto de chapas.
