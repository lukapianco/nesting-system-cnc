# ADR 007 — Chapa desenhada no sparrow, chapa usada vinda do DXF e cancelamento de processos

**Status:** aceito (V5.6) · **Plano:** fase 3 (chapa irregular), fase 1 (leitura do DXF) · **Complementa:** ADR 006

## Contexto

Na V5.5, o Automático mandava toda chapa desenhada (irregular, com recortes ou defeitos) para o motor clássico,
porque o sparrow só conhecia faixa retangular. Na prática isso é o caso mais comum numa chapa de sobra: o
Modelo 3 que o usuário mandou é uma chapa 3000 × 1200 já usada, com 5 recortes de gomo, desenhada junto com 12
anéis para cortar nela. O clássico usou 2.662 mm da chapa; o sparrow não podia ser usado.

Também apareceram dois problemas de operação:

* ao mudar modelo, chapa ou peças no meio de um cálculo, a tela recomeçava, mas o processo `prumo-sparrow` do cálculo
  anterior continuava rodando até o fim do tempo (o `worker.terminate()` mata a thread, não o processo filho);
* o painel "Servidor" lia o hardware uma vez e não mostrava o uso.

## Decisão

1. **Obstáculos fixos dentro da faixa.** O Prumo manda ao executável o contorno da chapa e os furos/defeitos
   (`prumo_sheet`). O executável calcula, com Clipper2, `(caixa da chapa − contorno) ∪ furos`, inverte anéis em sentido
   horário (senão o offset os encolhe até sumirem), infla por `b − g` e desloca para as coordenadas da faixa. Uma peça
   inflada por `g` que não toca um obstáculo inflado por `b − g` fica a pelo menos `b` dele, a mesma margem do resto
   da chapa.
2. **Usar o que o jagua-rs já tem.** Os obstáculos entram como zona de qualidade 0 do contêiner (o mesmo mecanismo
   de "defeitos" do jagua-rs), e o detector de colisão do jagua-rs já os enxerga. O que faltava estava no sparrow:
   colisão com obstáculo não tinha perda proporcional, então o separador não sabia para onde empurrar a peça. A
   perda passa a ser `quantify_collision_poly_poly(peça, obstáculo)`, a mesma medida usada entre duas peças, somada
   à perda de contêiner. Sem obstáculos, nada muda (a lista está em `PRUMO_MODIFICACOES.md`).
3. **O validador continua decidindo.** Ele já checava a peça contra o contorno real da chapa e contra os furos; não
   foi mexido. Se uma solução invade obstáculo, é rejeitada, e o job cai no clássico com aviso, como antes.
4. **Chapa usada desenhada junto com as peças.** O DXF Doctor marca como candidato a chapa um anel externo que tem
   furos e não tem netos, é pelo menos 1,5 × a área de todas as outras peças juntas, as comporta na sua caixa, tem
   menos de 80% de área de furos, e tem furos com forma de peça (não só círculos e oblongos de fixação) **ou** medida
   de chapa comercial (±2 mm). A tela pergunta ("parece uma chapa já usada") e o usuário escolhe; nada vira chapa
   sozinho. A escolha vai na opção de importação `sheetContour` e o anel sai da lista de peças.
5. **Cancelamento com dono.** O worker avisa o servidor do `pid` de cada processo filho. Para cancelar, o servidor
   primeiro manda `cancel` ao worker (que encerra o filho e espera ele sair, sem deixar processo zumbi) e, 1,5 s
   depois, termina o worker e mata qualquer filho que tenha sobrado. A tela fecha a conexão do cálculo antigo assim
   que a entrada muda, e o servidor trata a conexão fechada como cancelamento.
6. **Painel do servidor ao vivo.** O servidor mede o uso de CPU por núcleo a cada 1 s (diferença de `os.cpus()`); a
   tela consulta a cada 2 s enquanto a aba está visível.

## Medição (tempo igual para os dois motores, semente 1, mesma máquina)

| Caso | Clássico: comprimento usado | Sparrow: comprimento usado |
|---|---|---|
| Modelo 3 (12 anéis Ø405 na chapa usada 3000 × 1200, 5 recortes), 15 s | 2.662 mm | 2.426 mm |
| trueshape na chapa em degrau (`sheet_stepped`), 8 s | 873,7 mm | 426,2 mm |
| industrial na chapa com rampa e furo (`sheet_ramp_hole`), 8 s | 1.974,7 mm | 1.447,0 mm |
| içamento × 3 em `sheet_ramp_hole`, 8 s | 344,5 mm | 209,4 mm |

Todos válidos pelo validador independente e com todas as peças postas. No Modelo 3, o retalho final passou de
325 × 1188 para 561 × 1188 mm. Quando as peças não cabem na área da chapa (trueshape em `sheet_tooth_slot`), o
Automático continua indo para o clássico, que põe o que couber.

O teste `test/engine_sparrow.js` cobre os três casos de chapa irregular, o Modelo 3 e o cancelamento: abre um cálculo
de 60 s, fecha a conexão depois de 2,5 s e confere que não sobra processo `prumo-sparrow` vivo nem zumbi.

## Consequências

- O "fora do alcance" da ADR 006 perde a chapa irregular. Continuam fora: várias chapas, retalho como contêiner,
  rotação contínua e objetivo de corte.
- Um obstáculo muito recortado aumenta o custo de cada avaliação no sparrow; nos casos medidos não foi perceptível.
- A detecção de chapa usada é heurística. Por isso ela só sugere: o usuário confirma ou desfaz na tela.
