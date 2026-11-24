# Changelog

Todas as mudanças relevantes deste pacote ficam registradas aqui. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.1.0] - Não publicado

Primeira versão.

### Core (`hierarch-tree`)

- Estado canônico normalizado e imutável (`entities`, `nodes`, `rootIds`), com a árvore aninhada como visão derivada (`toTree`). O estado é dono do que recebe e é congelado.
- Identidade configurável por propriedade ou função, com normalização, detecção de colisões e troca explícita de chave (`rekeyEntity`).
- Entity Registry separado das ocorrências: a mesma entidade pode aparecer em várias posições, cada ocorrência com o próprio relacionamento. Políticas de remoção configuráveis.
- Structure Engine com `addNode`, `removeNode`, `moveNode`, `updateNode` e consultas (pais, filhos, ancestrais, descendentes, profundidade, caminho).
- Operações puras e atômicas `(state, input, config) => Result`, todas pelo mesmo pipeline de validação (estrutura → identidade → regras → validadores do consumidor), incluindo `updateEntity` e `rekeyEntity`.
- Relationship Rules Engine com precedência deny > allow > `mode` (padrão `restrictive`) e ciclos por identidade bloqueados por padrão.
- Validation Engine (`validateStructure`, com `CYCLE_DETECTED`), Search Engine, catálogo de códigos de erro e o wrapper com estado `createEntityStructure` (com `subscribe`).
- Zero dependências de runtime.

### Serialização e histórico

- `exportStructure` / `importStructure` versionados, com migrações.
- Histórico opcional de alterações (não é auditoria).

### Adapters opcionais

- `hierarch-tree/zod`: validadores de entidade e de relacionamento e schema de snapshot a partir de schemas Zod do consumidor (Zod clássico e `zod/mini`). Peer opcional `zod@^4.3.0`.
- `hierarch-tree/zustand`: uma store vanilla por estrutura, ações que devolvem `Result` e seletores que preservam referência. Peer opcional `zustand@>=5`.
- `hierarch-tree/react-hook-form`: o valor do form é o estado normalizado do core (sem segunda fonte de verdade), com resolver para o submit. Peers opcionais `react@>=18` e `react-hook-form@^7.92`.

[0.1.0]: https://github.com/Davi9130/hierarch-tree/releases/tag/v0.1.0
