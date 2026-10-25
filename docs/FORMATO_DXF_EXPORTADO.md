# Formato do DXF exportado pelo Prumo (contrato para outros sistemas)

Vale para `POST /api/export-dxf` (botão **Baixar .DXF de corte**) e `POST /api/export-remnants-dxf`
(**Baixar .DXF dos retalhos**). Feito para ser lido por máquinas/CAM **e** por sistemas que identificam peças num DXF
(ERP, rastreio de peças, laboratório de OS).

## Arquivo

* DXF ASCII **R12 (AC1009)**, quebras de linha CRLF, `$INSUNITS = 4` (**milímetro**), escala 1:1, eixo Y para cima,
  origem no canto inferior esquerdo da chapa. Peças **não** são espelhadas.
* Cada contorno é uma `POLYLINE` fechada (`70 = 1`) com `VERTEX`; curvas saem como polilinhas com erro ≤ *Flecha*.
* Entidades na **ordem de corte** (de dentro para fora: furos e peças-filhas antes do contorno da mãe).

## Camadas

| Camada | Conteúdo | Papel | Padrão |
|---|---|---|---|
| `1_CORTE_PECAS` | contorno externo das peças | **corte (peça)** | sempre |
| `1_PECA_IN_HOLE` | contorno das peças cortadas dentro do furo de outra (Part-in-Part) | **corte (peça)** | sempre |
| `2_CORTE_FUROS` | furos das peças | **corte (furo)** | sempre |
| `0_CHAPA_LIMITE` | contorno da chapa | referência | opcional |
| `0_CHAPA_FUROS_OBSTACULOS` | furos/defeitos da chapa | referência | opcional (junto com a chapa) |
| `3_RETALHOS_UTEIS` | retângulos de retalho útil | referência / estoque | opcional |
| `4_CAM_LEAD_IN` | entradas de corte (linhas/arcos **abertos**) | CAM | opcional |
| `5_TEXTO_PECAS` | `TEXT` com o nome da peça (ou medidas do retalho) | anotação | opcional |
| `6_CAM_SAIDA` | sobrepasse + saída de corte de cada contorno (linhas/arcos **abertos**; V5.10, não testado em máquina) | CAM | opcional |
| `7_MICROJUNTAS` | trecho do contorno externo que NÃO é cortado, uma polilinha aberta por microjunta (V5.10) | CAM | opcional |

**Contorno aberto nas microjuntas (opção, V5.10):** com "Abrir o contorno nas microjuntas", o contorno externo de
cada peça com microjunta sai em `1_CORTE_PECAS`/`1_PECA_IN_HOLE` como **trechos abertos** (só o que a máquina corta).
Use apenas se o CAM da máquina espera isso: um sistema que classifica peças por contenção vai ler esses trechos como
"contornos que não fecharam". O padrão continua sendo o contorno fechado, com as microjuntas (se pedidas) na camada 7.

**Por que o padrão é só corte:** um sistema que classifica peças por contenção (par/ímpar), sem olhar a camada,
lê o contorno da chapa como **uma peça gigante com todas as peças como furos**, os retalhos como peças e os lead-ins como
"contornos que não fecharam". Foi exatamente o que aconteceu ao anexar o `exemplo_icamento` exportado pela V5.3 no
laboratório de OS (1 "peça" 180×120 com 4 furos + 2 círculos). Com o padrão da V5.4, o mesmo arquivo dá as 4 peças:
2 olhais (cada um com o furo Ø25) e 2 buchas 14×14 (dentro dos furos).

## Como um sistema consumidor deve ler

1. **Só as camadas de corte** (`1_*` e `2_*`) definem peças. Ignore as outras ou use-as como referência
   (`0_CHAPA_LIMITE` = chapa; `3_RETALHOS_UTEIS` = sobras para estoque).
2. Classificação peça/furo por contenção par/ímpar **dentro das camadas de corte**: nível 0 = peça, 1 = furo,
   2 = peça dentro de furo (`1_PECA_IN_HOLE`), 3 = furo dessa peça, e assim por diante.
3. Se o sistema não filtra camadas, use a exportação **padrão** (só corte): ela continua correta por contenção pura.
4. Alternativa robusta: enviar o DXF ao endpoint de leitura do Prumo (`POST /api/upload-dxf`), que já devolve as peças
   separadas, os furos, as cópias agrupadas e o diagnóstico (ver ADR 001).

## DXF dos retalhos

`3_RETALHOS_UTEIS`: um retângulo fechado por retalho; `5_TEXTO_PECAS`: `Retalho #n LxA mm`. Cada retângulo é um item
de estoque. Retalhos respeitam a **mesma folga D_nom** das peças (verificado pelo validador independente), então podem
ser recortados sem atingir peça.

## Garantias verificadas por teste (`test/dxf_doctor.js`, seção EXPORTAÇÃO)

* Exportação padrão relida por um **leitor ingênuo** (sem camadas) = mesmo número de peças do layout, 0 contornos abertos.
* Exportação padrão **e** completa relidas pelo leitor do Prumo = mesmas peças; a chapa vira moldura; retalhos e lead-ins
  não viram peças.
