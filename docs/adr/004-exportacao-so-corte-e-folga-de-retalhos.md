# ADR 004 — Exportação "só corte" por padrão, ida e volta garantida, folga dos retalhos

**Status:** aceito (V5.4)

## Contexto (relato do usuário, reproduzido)

O `exemplo_icamento` exportado pela V5.3 ("Exportar .DXF p/ Máquina CNC", padrão) e anexado ao laboratório de OS
(outra aplicação do usuário) virou **1 peça 180×120 com 4 furos + 2 círculos**, com o aviso "6 contorno(s) não
fecharam". Reproduzido com um leitor "ingênuo" (sem filtro de camada, peça/furo por contenção par/ímpar), igual ao
comportamento típico de outros sistemas:

| Exportação V5.3 (padrão) | Leitor ingênuo | Leitor do próprio Prumo |
|---|---|---|
| chapa + 2 olhais (com furo Ø25) + 2 buchas + 2 retalhos + 6 lead-ins | 3 "peças": a chapa com 4 furos e 2 círculos; 6 abertos | 4 tipos de peça (2 eram retalhos), alerta de cruzamento |

Causas:
1. O contorno da chapa (`0_CHAPA_LIMITE`) envolve tudo: por contenção, a chapa vira a peça e as peças viram furos
   (e a paridade inverte: o furo Ø25 do olhal vira peça e a bucha vira furo dele).
2. Retalhos (`3_RETALHOS_UTEIS`) são retângulos fechados: viram peças (ou furos da chapa).
3. Lead-ins (`4_CAM_LEAD_IN`) são abertos: viram "contornos que não fecharam".
4. **Bug do motor** encontrado no caminho: o retalho grande **encostava e invadia 1,5 mm²** do olhal. Ao extrair
   retalhos, a caixa de bloqueio de cada peça recebia a folga só à direita/acima (correto para posicionar peças, errado
   para retalhos), e o arredondamento a 0,1 mm empurrava a borda para dentro da peça. A régua independente
   (`bench/metrics.js`) dilata em todos os lados; a diferença ficava escondida na tolerância de 5% do teste de KPI.
5. **Bug do motor**, encontrado pela nova verificação do validador: em chapa irregular, o teste retalho × furo da chapa
   usava cantos recuados 0,5 mm, e um retalho podia atravessar a borda de um furo da chapa (`sheet_ramp_hole`).

## Decisão

* **Exportação padrão = só geometria de corte** (`1_CORTE_PECAS`, `1_PECA_IN_HOLE`, `2_CORTE_FUROS`), em ordem de corte.
  Chapa, retalhos, lead-ins e nomes viram **opções**, cada um na sua camada. Novo `POST /api/export-remnants-dxf`
  (DXF só dos retalhos, para estoque/rastreio de sobras). Contrato em `docs/FORMATO_DXF_EXPORTADO.md`.
* **Leitor do Prumo reconhece as próprias camadas** (chapa = moldura, mesmo irregular; retalhos e furos de chapa não
  viram peças e são relatados; lead-in e texto são auxiliares) e **nomes usuais de camadas auxiliares** (cota, dim,
  texto, hachura, eixo, centro, construção, aux, carimbo, legenda, título…, sem acento/caixa). Qualquer camada pode ser
  forçada de volta (`forceLayers` / lista de layers na tela).
* Placa com peça aninhada no recorte **não** é moldura: "contornos internos com furos próprios" só conta junto com
  conteúdo com forma de peça (achado pela ida e volta do preset `industrial`).
* **Retalhos:** caixa de bloqueio com D_nom em **todos** os lados, comparação exata (sem a folga de 0,1 mm),
  arredondamento **para dentro**; em chapa irregular, teste exato segmento × retângulo (Liang–Barsky) com a margem da chapa.
* **Validador independente** passa a reprovar retalho que invade peça (`RETALHO_SOBRE_PECA`), que fica a menos de D_nom
  (`RETALHO_FOLGA`) ou que invade furo da chapa (`RETALHO_SOBRE_OBSTACULO`).

## Verificação

* `test/dxf_doctor.js` → seção EXPORTAÇÃO: para `icamento`, `industrial` e `trueshape`, a exportação padrão relida pelo
  **leitor ingênuo** dá exatamente as peças do layout e 0 contornos abertos; padrão e completa relidas pelo leitor do
  Prumo dão as mesmas peças (a chapa vira moldura). DXF de retalhos relido = 1 item por retalho. Teste negativo:
  retalho empurrado sobre uma peça é reprovado.
* 25/25 execuções (5 cenários × 5 sementes, inclusive chapas irregulares) com melhor layout e elite aprovados.

## Consequências

* Retalhos ficam um pouco menores (agora honestos: recortáveis sem atingir peça). Os layouts mudam porque o retalho
  entra no critério de desempate; a equivalência exata da ADR 002 vale até a V5.3.
* Quem precisava da chapa/retalhos/lead-ins no mesmo arquivo marca as opções; o software de CAM deve mapear por camada.
