# ADR 011 — Acabamento do corte (saída, sobrepasse, microjuntas) e relatório em PDF

**Status:** aceito (V5.10) · **Plano:** passo 4 combinado em 24/10 (CAM sem máquina) · **Complementa:** ADR 004 e 010

## Contexto

A tabela de funções profissionais de CAM do plano tem itens que dependem de dados de máquina (pós-processador,
G-code, tabela de corte) e itens que são só geometria e documento. O combinado foi adiantar os segundos, sempre
marcados como **não testados em máquina**, até haver um parceiro para o corte de teste (portão P5).

## Decisão

1. **Sobrepasse (overburn):** o corte continua `overburn_length` mm além do ponto de entrada, ao longo do contorno
   (até 25% do perímetro), para fechar sem marca.
2. **Saída de corte (lead-out):** do fim do sobrepasse (ou do ponto de entrada) para a sucata, no mesmo tipo da entrada
   (arco ou reta), com `lead_out_length` mm. O caminho é validado como uma entrada ao contrário (dentro da chapa, em
   sucata, longe de outras peças). Sem espaço, tenta a metade; sem espaço ainda, o contorno fica sem saída e a tela
   avisa. O deslocamento em vazio seguinte passa a sair do fim da saída.
3. **Microjuntas (tabs):** trechos de `tab_width` mm do contorno externo que não são cortados, `tabs_per_part` por
   peça, distribuídos ao longo do perímetro longe da entrada e, quando possível, em arestas retas com pelo menos o
   dobro da largura (perto do lugar ideal). Só em peças com o maior lado até `tab_max_part_size` (0 = todas). Furo não
   recebe microjunta: o miolo tem que cair. Peça com perímetro curto demais recebe menos.
4. **Tudo desligado por padrão** (0 mm). Sem pedir, o corte, o DXF e as métricas são os da V5.9.
5. **Validador independente:** saída fora da chapa ou sobre material de peça é erro; microjunta fora do contorno
   externo da própria peça (> 0,05 mm) ou com largura diferente da pedida (> 0,05 mm) é erro; contorno sem espaço
   para a saída é aviso.
6. **DXF:** camadas opcionais `6_CAM_SAIDA` (sobrepasse + saída) e `7_MICROJUNTAS` (o trecho não cortado). Opção
   "Abrir o contorno nas microjuntas" exporta o contorno externo em trechos abertos, para CAM que espera isso; o padrão
   continua fechado (outros sistemas leem contorno aberto como erro). Contrato em `docs/FORMATO_DXF_EXPORTADO.md`.
7. **Relatório em PDF** (`POST /api/report-pdf`, botão "Baixar relatório (PDF)"): uma página por chapa com o desenho
   (ordem de corte, entradas, saídas, microjuntas, retalhos), os números do plano, o tempo estimado, os retalhos e a
   lista de peças; com várias chapas, uma página de resumo antes. Escrito sem dependências (PDF 1.4, Helvetica,
   WinAnsi), para o servidor não depender de pacote externo. O rodapé de cada página diz o que não foi testado.
8. **Tempo estimado** passa a contar o sobrepasse e a saída como corte e a descontar as microjuntas.

## Medição

Nos layouts salvos do Automático (trueshape, industrial, Modelo 1, Modelo 2, içamento), com saída 4 mm, sobrepasse
1 mm e 2 microjuntas de 1,5 mm: todos aprovados pelo validador; saída sem espaço em 1 de 48 contornos (içamento, chapa
500 × 300 apertada); planejamento de 165 a 200 ms no Modelo 2 (87 gomos) com cada opção ligada.

## O que isto NÃO é

- Não é G-code nem pós-processador: isso precisa da máquina e do manual do controle (blocos 1 a 3 da coleta).
- Não diz se 1,5 mm de microjunta segura a peça ou se 4 mm de saída evitam a marca: depende de material, espessura,
  processo e máquina. Os campos começam em 0 justamente por isso.
- Linha comum, corte em cadeia, sequência térmica e corte do esqueleto continuam no plano (precisam de corte de teste).
