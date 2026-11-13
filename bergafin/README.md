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
