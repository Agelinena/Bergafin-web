# Bergafin-web

Fork do [jellyfin-web](https://github.com/jellyfin/jellyfin-web) que acompanha as versões estáveis oficiais. Ele também gera a imagem **`ghcr.io/agelinena/bergafin`**, que é o Jellyfin oficial com este web por cima.

## O que muda em relação ao oficial

- **Login pelo Authentik:** a tela de login ganha o botão "Entrar com Authentik", que depende do plugin [Bergafin Auth](https://github.com/Agelinena/Bergafin-auth). O web troca o ticket por uma sessão sozinho, sem a página intermediária do plugin. Sem o plugin, a tela fica igual à oficial.

## Como acompanha o oficial

- **O código fica em cima da tag oficial** (`vX.Y`) e é mexido o mínimo possível:
  - a lógica nova fica em `src/bergafin/` e `bergafin/`;
  - o código oficial só ganha ganchos pequenos.
- **Atualização diária:** o workflow `bergafin-sync.yml` confere a última versão estável. Quando sai uma nova:
  1. reaplica (rebase) os nossos commits em cima dela e publica o `main`;
  2. monta a imagem e confere se o Jellyfin sobe com o nosso web;
  3. se der conflito, abre uma issue e nada muda.
- **Workflows do projeto oficial:** ficam desligados neste repositório.

## Imagem

| Tag | Conteúdo |
|---|---|
| `latest` | Última versão que compilou e passou na conferência |
| `12.4` | Jellyfin 12.4 + Bergafin-web atual |
| `12.4-<commit>` | Versão exata, para voltar atrás |

No compose, use `ghcr.io/agelinena/bergafin:latest` no lugar de `jellyfin/jellyfin`.

## Cast (Chromecast)

O cast usa o **Default Media Receiver** do Google. Ele é grátis, não precisa de registro e funciona em qualquer Chromecast, inclusive os antigos.

- **Como funciona:** o receptor do Jellyfin, que normalmente roda dentro do Chromecast, é **emulado no aparelho que transmite** (`src/bergafin/cast/dmrReceiver.js`). Esse aparelho escolhe o stream, manda só o link ao Chromecast, cuida da fila, das legendas e do áudio e informa o progresso ao Jellyfin.
- **Formatos** (`src/bergafin/cast/deviceProfile.js`):
  - **Toca direto:** H.264 até 1080p em MP4.
  - **Vira HLS:** o resto. Quando dá, o vídeo é só copiado, sem recodificar.
  - **Legendas:** as de texto vão como WebVTT e trocam na hora; as de imagem são gravadas no vídeo.
- **Mudanças no plugin oficial** (`plugins/chromecastPlayer`): só dois ganchos, o ID do receptor e o envio das mensagens.
- **Onde funciona:** no Chrome do PC e no app Bergafin (Android).
- **Limitações:**
  - Se a página que transmite for recarregada, a fila se perde. O item atual continua tocando e os controles seguem funcionando.
  - No celular, o app precisa continuar aberto, mesmo em segundo plano, para avançar a fila e informar o progresso.
