# Arquitetura (ADR-001: core puro)

Status: **aceito** (TES-27 / TES-28, 2026-11-24). Escopo: o core em `src/core/`. Serialização, histórico e adapters (Zustand, Zod, RHF) ficam para os próximos PRs e não estão neste documento.

## Contexto

O `hierarch-tree` gerencia estruturas hierárquicas genéricas: um cadastro central de entidades, várias ocorrências da mesma entidade na estrutura e um relacionamento próprio para cada ocorrência. O core não pode conhecer nenhum domínio (PF/PJ, CPF/CNPJ, sócios...) e precisa servir de fonte única de verdade para os adapters que vêm depois.

## Decisões

### 1. Estado canônico normalizado e imutável

```ts
interface StructureState<TEntity, TRelationship> {
  entities: Record<EntityKey, EntityRecord<TEntity>>;   // cadastro central
  nodes: Record<NodeId, StructureNode<TRelationship>>;  // ocorrências
  rootIds: NodeId[];
}
interface StructureNode<TRelationship> {
  id: NodeId; entityKey: EntityKey; parentId: NodeId | null; childIds: NodeId[]; relationship: TRelationship;
}
```

- Identidade (`EntityKey`), ocorrência (`NodeId`) e relacionamento (`node.relationship`) são separados no próprio formato do estado.
- A árvore aninhada (`toTree`) é só uma visão derivada e nunca é armazenada.
- O estado é composto de objetos simples e serializáveis, sem `Map`. Todas as leituras usam checagem de propriedade própria, então chaves como `"__proto__"` ou `"constructor"` funcionam como qualquer outra.
- Uma mutação copia apenas o que mudou (copy-on-write). As partes não tocadas mantêm a mesma referência, o que facilita a memoização em React e Zustand.

### 2. Operações puras

Toda mutação tem a forma `(state, input, config) => OperationResult`:

```ts
type OperationResult = { ok: true; value: { state; events; warnings; ...extra } }
                     | { ok: false; errors: ValidationError[] };
```

A atomicidade vem do desenho: a operação monta um estado candidato e, se houver qualquer erro, devolve só os erros. Quem chamou continua com o estado antigo, idêntico por referência. Os `events` descrevem o que mudou e servem de base para o futuro módulo de histórico.

`createEntityStructure(config)` é só um wrapper com estado sobre essas funções: guarda o estado da instância e aplica um resultado apenas quando ele é `ok`.

### 3. Um único pipeline de validação

Toda operação que muda o estado (`registerEntity`, `addNode`, `removeNode`, `moveNode`, `updateRelationship`, `updateEntity`, `rekeyEntity` e `removeEntity`) termina em `validateChange`, que valida o **estado candidato** no escopo tocado pela operação:

1. **Estrutura:** referências, `maxDepth` (para a subárvore movida inteira) e ciclos por identidade.
2. **Identidade:** o cadastro alterado ainda resolve para a própria chave.
3. **Relacionamentos:** duplicidade entre irmãos e as regras de **todo** vínculo que entra ou sai dos nós tocados, com o validador customizado sempre executado.
4. **Validadores do consumidor:** rodam em cada nó tocado e no pai dele.

Erros de estrutura ou de identidade interrompem o pipeline, porque as etapas seguintes partem de um estado íntegro. As etapas 3 e 4 rodam sempre juntas e acumulam os erros.

Não existe caminho que contorne as regras. Por exemplo, `updateEntity` revalida todas as ocorrências da entidade, porque trocar o `type` pode invalidar um vínculo que já existe. As checagens prévias de cada operação (nó inexistente, ciclo por ocorrência, índice inválido etc.) são da categoria `structure` e também devolvem `Result`.

`validateStructure(state, config)` primeiro checa a integridade referencial (referências pendentes, vínculos pai/filho inconsistentes, nós inalcançáveis, chaves do registry) e depois roda o pipeline completo sobre todos os nós. Esse é o ponto de entrada para estados que vêm de fora.

### 4. Identidade

- A identidade é configurável por propriedade (`identity.key`) ou por função (`identity.getKey`), com `normalize` opcional.
- Valores ausentes, não primitivos, não finitos ou vazios após a normalização são rejeitados (`IDENTITY_MISSING`, `IDENTITY_INVALID`, `IDENTITY_EMPTY`).
- A troca de identidade só acontece pela operação explícita `rekeyEntity`, que move o cadastro e atualiza todas as ocorrências. Se `updateEntity` receber dados que resolvem para outra chave, falha com `IDENTITY_CHANGE_REQUIRES_REKEY`.
- `addNode({ entity })` registra a entidade quando a identidade é nova. Quando ela já existe, **reaproveita o cadastro sem alterá-lo**: para mudar os dados, use `updateEntity`. Já `registerEntity` com uma identidade existente falha com `IDENTITY_COLLISION`.

### 5. Políticas explícitas (`config.policies`)

| Política | Padrão | Alternativas |
|---|---|---|
| `siblingDuplicates` | `"deny"` | `"allow"` |
| `entityRemoval` | `"block"` | `"when-unreferenced"` (também remove o cadastro quando a última ocorrência sai) e `"force"` (`removeEntity` remove as ocorrências com os descendentes) |
| `identityCycles` | `"deny"` (aprovado pelo Davi) | `"allow"` |
| `maxDepth` | ilimitado | inteiro ≥ 0 (as raízes têm profundidade 0) |
| `relationships.mode` | `"restrictive"` (aprovado pelo Davi) | `"permissive"` |

**Ciclos por identidade** são checados no grafo de entidades: uma aresta `chave do pai → chave do filho` para cada ocorrência. Assim, tanto `X → Y → X` no mesmo caminho quanto `X → Y` num ramo com `Y → X` em outro são bloqueados. Os ciclos por ocorrência (mover um nó para dentro dos próprios descendentes) são sempre bloqueados, com `CYCLE_DETECTED`.

### 6. Regras de relacionamento

O matching declarativo só compara primitivos, com `===` ou "um de" quando recebe um array. Qualquer comparação mais rica usa uma função. A precedência é determinística: deny > allow > `mode`, e o validador customizado sempre roda. Os detalhes estão em [relationship-rules.md](./relationship-rules.md).

### 7. Determinismo e erros

- `createId` é injetável. O padrão é `crypto.randomUUID()`, com fallback quando ele não está disponível.
- Os códigos de erro do core formam um catálogo tipado (`CORE_ERROR_CODES` / `CoreErrorCode`), e cada código tem uma categoria (`structure`, `identity`, `relationship` ou `domain`). Validadores do consumidor podem devolver códigos próprios.
- Uma configuração inválida é erro de programação e **lança** `EntityStructureConfigError`. Dados inválidos **nunca lançam**: viram um `Result` com erro.

### 8. Zero dependências de runtime

O core não depende de React, Zustand, Zod nem Immer. As travessias são iterativas e não estouram a pilha; há teste com 20 mil níveis.

## Consequências e pontos em aberto

- **Custo O(n) por mutação.** Copiar os registros de `entities`/`nodes` e montar o grafo de identidades para checar ciclos é linear no tamanho do estado: cerca de 0,5 a 1 ms por operação com 3 mil nós no Node 22. Para formulários e estruturas de até ~10⁴ nós isso basta. Se for preciso escalar, as opções são um índice de ocorrências por chave, estruturas persistentes ou operações em lote.
- **Regras só para vínculos pai → filho.** Ainda não há regra que restrinja quem pode ser **raiz**. Hoje o consumidor resolve isso com um validador, checando `parent === null`.
- **Transações com várias operações.** Como as operações são puras, dá para compô-las encadeando os resultados, mas ainda não existe um helper `transaction`.
- **Consultas de compatibilidade** (`canRelate`, `getAllowedChildren`...) avaliam apenas as regras e o validador customizado, com `relationship` indefinido (a menos que seja informado). Elas não checam duplicidade nem ciclos.
- **`createId` é chamado mesmo quando `addNode` acaba falhando** na validação, então os ids sequenciais nos testes podem pular números.
- **Serialização e histórico (TES-30)** ficam em `src/core/serialization` e `src/core/history`, fora das operações. A importação monta o estado e o passa por `validateStructure`, então não existe um segundo validador. O que só existe no formato plano (ids e chaves repetidos, colisão depois da normalização) é checado antes. O histórico só acumula os `events` que as operações já devolvem e **não é auditoria**.
- **Próximos PRs:** adapters Zustand, Zod e RHF (TES-31 a TES-33).
