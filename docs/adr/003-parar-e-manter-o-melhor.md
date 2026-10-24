# ADR 003 — "Parar e manter o melhor" (cancelamento cooperativo)

**Status:** aceito (V5.3) · **Fase do plano:** 0.3

## Contexto

Com peças reais e curvas, o orçamento "Padrão" (15.000 avaliações) pode levar horas (Modelo 2: ~1,6 s por avaliação).
Sem tempo máximo configurado, o operador não tinha como encerrar e ficar com o melhor layout: fechar a página
matava o worker e perdia tudo.

## Opções

1. `postMessage` para o worker: não funciona, o laço de otimização é síncrono e só leria a mensagem no fim.
2. Fatiar o laço com `setImmediate`: muda o fluxo do otimizador e o determinismo da ordem de eventos.
3. **`SharedArrayBuffer` + `Atomics`**: o servidor grava 1 numa posição compartilhada; o laço lê a cada avaliação.

## Decisão

Opção 3. `POST /api/stop/:jobId`:
* job rodando → grava a bandeira; o worker sai do laço como no limite de tempo, **finaliza** (retalhos finos, CAM,
  validação independente de cada solução enviada) e manda `done` com `stoppedByUser: true`;
* job ainda na fila → sai da fila (sem resultado);
* job desconhecido → 404.

A interface mostra o botão **Parar e manter o melhor** durante a execução.

## Consequências

* A parada acontece **ao fim da avaliação em curso** (Modelo 1: ~0,2 s; Modelo 2: ~1,6 s), não instantaneamente.
  O critério "< 1 s" do plano vale para peças simples; para peças pesadas, o tempo é o de uma avaliação.
* Reprodutibilidade: o resultado depende de **quando** se parou (como no limite de tempo). Para reproduzir um layout,
  use o mesmo número de avaliações (modo Manual) e a mesma semente.
