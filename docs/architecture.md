# Arquitetura (ADR-001: core puro)

Status: **aceito** (TES-27 / TES-28, 2026-11-24; revisado no TES-35 com os achados do TES-29). Escopo: o core em `src/core/`. Serialização, histórico e adapters (Zustand, Zod, RHF) ficam para os próximos PRs e não estão neste documento.

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
- **Ordem das chaves (F3).** `entities` e `nodes` são objetos simples, então seguem a ordem de propriedades do JavaScript: chaves que parecem índices inteiros (`"2"`, `"10"`) vêm primeiro, em ordem numérica, e só depois as outras, na ordem de inserção. Isso afeta `getAllEntities`, `Object.keys(state.nodes)` e o `nodeIds` de `ENTITY_REKEYED` quando a identidade é numérica e curta. A ordem que importa para a estrutura (`rootIds` e `childIds`) é sempre preservada, porque é guardada em arrays. Se a ordem do cadastro importar, use uma identidade não numérica, por exemplo com um prefixo no `normalize`.

#### O estado é dono do que recebe (TES-35 / F1)

O estado é imutável **de fato**, não só por convenção. Tudo o que entra nele é congelado com `Object.freeze`, sempre, inclusive em produção:

- **Objetos simples e arrays** (entidade em `registerEntity`/`addNode`/`updateEntity`/`rekeyEntity`, relacionamento em `addNode`/`updateRelationship`) recebem uma **cópia rasa** congelada. O objeto que o consumidor passou continua dele e mutável, e mudar esse objeto depois não altera o estado.
- **Instâncias de classe** (protótipo diferente de `Object.prototype`/`null`) são **congeladas no lugar**, sem cópia, porque uma cópia perderia campos privados (`#x`) e slots internos (`Date`, `Map`). O consumidor deixa de poder mutar essa instância.
- Registros, nós, `childIds`, `rootIds`, os mapas `entities`/`nodes` e o próprio objeto de estado também são congelados. Um valor que já está congelado é guardado pela mesma referência, então as partes não tocadas continuam estáveis.
- `createEntityStructure({ initialState })` e `importStructure` assumem estados vindos de fora do mesmo jeito: o que não está congelado é copiado e congelado, e o objeto do consumidor fica intacto. Um estado produzido pelo core é aceito pela mesma referência.
- Os `events` carregam os valores guardados no estado, e não os objetos de entrada.
- **O congelamento é raso.** Objetos aninhados dentro de uma entidade ou relacionamento não são copiados nem congelados. Trate-os como imutáveis, ou modele os dados que as regras leem como propriedades de primeiro nível.
- Em modo estrito (todo módulo ESM), uma mutação in-place lança `TypeError`. Para mudar dados, use as operações (`updateEntity`, `updateRelationship`...), que passam pelo pipeline de validação. Adapters que guardam valores mutáveis (RHF) devem sempre entregar ao core um objeto novo.

**Custo:** congelar e copiar só o que mudou soma ~2–7% por operação com 10 mil nós (tabela em "Consequências"). Assumir um `initialState` externo de 10 mil nós custa ~25 ms a mais, uma vez só (~20 → ~45–55 ms, incluindo a validação). Por isso o congelamento fica ligado também em produção: o comportamento é o mesmo em todos os ambientes.

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
- Sem `normalize`, o valor bruto é a identidade: `" ABC "` e `"ABC"` são entidades diferentes (F6). Para ignorar espaços e caixa, normalize explicitamente, por exemplo `normalize: (value) => value.trim().toUpperCase()`, ou `(value) => value.replace(/\D/g, "")` para documentos só com dígitos.
- `addNode({ entity })` registra a entidade quando a identidade é nova. Quando ela já existe, **reaproveita o cadastro sem alterá-lo**: para mudar os dados, use `updateEntity`. Se os dados informados forem diferentes dos cadastrados (comparação rasa), o resultado traz o warning `ENTITY_DATA_IGNORED`, e as regras continuam usando o cadastro antigo. Já `registerEntity` com uma identidade existente falha com `IDENTITY_COLLISION`.

### 5. Políticas explícitas (`config.policies`)

| Política | Padrão | Alternativas |
|---|---|---|
| `siblingDuplicates` | `"deny"` | `"allow"` |
| `entityRemoval` | `"block"` | `"when-unreferenced"` (também remove o cadastro quando a última ocorrência sai) e `"force"` (`removeEntity` remove as ocorrências com os descendentes) |
| `identityCycles` | `"deny"` (aprovado pelo Davi) | `"allow"` |
| `maxDepth` | ilimitado | inteiro ≥ 0 (as raízes têm profundidade 0) |
| `relationships.mode` | `"restrictive"` (aprovado pelo Davi) | `"permissive"` |

**Ciclos por identidade** são checados no grafo de entidades: uma aresta `chave do pai → chave do filho` para cada ocorrência. Assim, tanto `X → Y → X` no mesmo caminho quanto `X → Y` num ramo com `Y → X` em outro são bloqueados.

A checagem é **incremental** (TES-35 / P1). Como o estado anterior já era acíclico, só um vínculo novo pode fechar um ciclo, e o vínculo `P → C` fecha um ciclo se, e somente se, `P` é alcançável a partir de `C`. Por isso a checagem só roda nas operações que criam vínculos (`addNode`, `moveNode`, `removeNode` com `reparent` e `rekeyEntity`) e faz uma DFS a partir da entidade filha de cada vínculo novo, percorrendo só o que é alcançável dela. `updateRelationship`, `updateEntity`, `registerEntity` e as remoções em cascata não criam vínculos e pulam a checagem. Um `addNode` que acabou de registrar a entidade também pula, porque ela não tem outra ocorrência. `validateStructure` (estados vindos de fora) continua checando o grafo inteiro. Os ciclos por ocorrência (mover um nó para dentro dos próprios descendentes) são sempre bloqueados, com `CYCLE_DETECTED`.

### 6. Regras de relacionamento

O matching declarativo só compara primitivos, com `===` ou "um de" quando recebe um array. Qualquer comparação mais rica usa uma função. As propriedades são lidas como em `identity.key` (acesso normal), então getters e propriedades herdadas de instâncias de classe também casam (F2).

> **As regras valem só para vínculos pai → filho.** Uma raiz não tem pai, então nunca passa pelas regras nem pelo `relationships.validate`, nem quando vira raiz, nem num `updateEntity`. Para restringir quem pode ser raiz, use um validador em `config.validators` que cheque `parent === null`. A precedência é determinística: deny > allow > `mode`, e o validador customizado sempre roda. Os detalhes estão em [relationship-rules.md](./relationship-rules.md).

### 7. Determinismo e erros

- `createId` é injetável. O padrão é `crypto.randomUUID()`, com fallback quando ele não está disponível.
- Os códigos de erro do core formam um catálogo tipado (`CORE_ERROR_CODES` / `CoreErrorCode`), e cada código tem uma categoria (`structure`, `identity`, `relationship` ou `domain`). Validadores do consumidor podem devolver códigos próprios.
- Uma configuração inválida é erro de programação e **lança** `EntityStructureConfigError`. Dados inválidos **nunca lançam**: viram um `Result` com erro.

### 8. Zero dependências de runtime

O core não depende de React, Zustand, Zod nem Immer. As travessias são iterativas e não estouram a pilha; há teste com 20 mil níveis.

## Consequências e pontos em aberto

- **Custo O(n) por mutação.** Copiar os mapas `entities`/`nodes` (copy-on-write raso) é linear no tamanho do estado. Até o TES-35, a checagem de ciclos por identidade remontava o grafo inteiro a cada mutação e era ~70% do custo. Medição real com 10.001 nós (100 grupos × 99 folhas, modo restritivo), Node 22, Apple Silicon:

  | Operação | Antes (`main` do TES-30) | Depois (TES-35: P1 + F1) |
  |---|---|---|
  | `addNode` (entidade nova) | 7,9 ms | 2,8 ms |
  | `addNode` (2ª ocorrência de uma entidade) | 6,1 ms | 3,3 ms |
  | `updateRelationship` | 5,9 ms | 1,4 ms |
  | `updateEntity` | 7,7 ms | 3,0 ms |
  | `moveNode` (folha / subárvore de 100 nós) | 6,0 / 6,2 ms | 3,0 / 3,1 ms |
  | Montar 10 mil nós só com `addNode` | 38,2 s | 14,7 s |

  O que sobra é a cópia dos mapas (uma por mapa alterado) e, em `moveNode`/`addNode` de entidade existente, um índice de ocorrências montado numa passada. Para formulários e estruturas de até ~10⁴ nós isso basta. Se for preciso escalar, as opções são um índice de ocorrências persistente no estado, estruturas persistentes ou operações em lote (montar uma estrutura grande de uma vez deve usar `importStructure`/`initialState`, ~50 ms para 10 mil nós).
- **Regras só para vínculos pai → filho** (ver a decisão 6). Ainda não há regra que restrinja quem pode ser **raiz**. Hoje o consumidor resolve isso com um validador, checando `parent === null`.
- **Configuração memoizada (F5).** A configuração é resolvida uma vez por objeto e guardada num `WeakMap`. Mudar o mesmo objeto depois do primeiro uso (dar `push` numa regra, trocar `mode`) **é ignorado sem aviso**. Trate a configuração como imutável: para mudar regras, crie um objeto novo (`{ ...config, relationships: { ...config.relationships, rules: [...] } }`) e, no wrapper, uma instância nova de `createEntityStructure`.
- **Listeners isolados (F4).** No wrapper, uma exceção num listener de `subscribe` não desfaz a mutação, não impede os outros listeners e não troca o `Result` de quem chamou: ela vai para `onListenerError` (padrão: `console.error`).
- **Transações com várias operações.** Como as operações são puras, dá para compô-las encadeando os resultados, mas ainda não existe um helper `transaction`.
- **Consultas de compatibilidade** (`canRelate`, `getAllowedChildren`...) avaliam apenas as regras e o validador customizado, com `relationship` indefinido (a menos que seja informado). Elas não checam duplicidade nem ciclos.
- **`createId` é chamado mesmo quando `addNode` acaba falhando** na validação, então os ids sequenciais nos testes podem pular números.
- **Serialização e histórico (TES-30)** ficam em `src/core/serialization` e `src/core/history`, fora das operações. A importação monta o estado e o passa por `validateStructure`, então não existe um segundo validador. O que só existe no formato plano (ids e chaves repetidos, colisão depois da normalização) é checado antes. O histórico só acumula os `events` que as operações já devolvem e **não é auditoria**.
- **Adapters entregues:** Zustand (`hierarch-tree/zustand`), Zod (`hierarch-tree/zod`) e RHF (`hierarch-tree/react-hook-form`), todos consumindo o core por operações puras; veja `zustand.md`, `zod.md`, `react-hook-form.md` e `examples.md`.
