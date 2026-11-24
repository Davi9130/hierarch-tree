# API reference (core)

Tudo é exportado por `hierarch-tree`. Os genéricos são `TEntity` (dados do cadastro) e `TRelationship` (metadados do vínculo de cada ocorrência).

- [Configuração](#configuração)
- [Estado e resultados](#estado-e-resultados)
- [Operações puras](#operações-puras)
- [Consultas](#consultas)
- [Regras e validação](#regras-e-validação)
- [Wrapper com estado: `createEntityStructure`](#wrapper-com-estado-createentitystructure)
- [Eventos](#eventos)
- [Serialização: `exportStructure` / `importStructure`](#serialização-exportstructure--importstructure)
- [Histórico opcional](#histórico-opcional)
- [Códigos de erro](#códigos-de-erro)

## Configuração

```ts
interface EntityStructureConfig<TEntity, TRelationship> {
  identity:
    | { key: IdentityProperty<TEntity>; normalize?: (value: string) => string }
    | { getKey: (entity: TEntity) => string | number | null | undefined; normalize?: (value: string) => string };
  relationships?: { mode?: "restrictive" | "permissive"; rules?: RelationshipRule[]; validate?: (ctx) => Verdict };
  validators?: StructureValidator<TEntity, TRelationship>[];
  policies?: {
    siblingDuplicates?: "deny" | "allow";                    // padrão "deny"
    entityRemoval?: "block" | "when-unreferenced" | "force"; // padrão "block"
    identityCycles?: "deny" | "allow";                       // padrão "deny"
    maxDepth?: number;                                       // raízes = 0; padrão ilimitado
  };
  createId?: () => string; // padrão crypto.randomUUID()
}
```

- `identity.key` só aceita propriedades cujo valor é `string | number`. O valor bruto passa por `String(...)` e depois por `normalize`.
- Validador do consumidor:

```ts
type StructureValidator<TEntity, TRelationship> = (ctx: {
  node: NodeView<TEntity, TRelationship>;            // nó + `entity` (dados do cadastro)
  parent: NodeView<TEntity, TRelationship> | null;
  children: NodeView<TEntity, TRelationship>[];
  state: StructureState<TEntity, TRelationship>;
  operation: OperationName | "validateStructure";
  context: unknown;
}) => Verdict | Verdict[];

type Verdict =
  | { valid: true }
  | { valid: false; code?: string; message?: string; severity?: "error" | "warning"; details?: Record<string, unknown> };
```

O validador roda em cada nó tocado pela operação e também no pai dele, de modo que uma regra agregada (como "a soma das participações dos filhos ≤ 100%") é reavaliada quando um filho muda. Sem `code`, o erro sai como `VALIDATION_FAILED` (categoria `domain`).

- Sem `normalize`, a identidade é o valor bruto, então `" ABC "` e `"ABC"` são entidades diferentes. Para ignorar espaços, normalize: `identity: { key: "code", normalize: (value) => value.trim() }`.

Uma configuração inválida lança `EntityStructureConfigError`. A configuração é resolvida e memoizada por objeto na primeira vez que é usada. **Mudanças posteriores no mesmo objeto são ignoradas sem aviso** (por exemplo, `config.relationships.rules.push(...)`). Trate a configuração como imutável e crie um objeto novo para mudar regras.

## Estado e resultados

```ts
createEmptyState<TEntity, TRelationship>(): StructureState<TEntity, TRelationship>

type OperationResult<TEntity, TRelationship, TExtra = {}> =
  | { ok: true; value: { state; events: StructureEvent[]; warnings: ValidationWarning[] } & TExtra }
  | { ok: false; errors: ValidationError[] };

interface ValidationError {          // ValidationWarning tem o mesmo formato
  code: ErrorCode;
  message: string;
  category: "structure" | "identity" | "relationship" | "domain";
  nodeId?: NodeId;
  entityKey?: EntityKey;
  path?: NodeId[];                   // da raiz até `nodeId`
  ruleId?: string;
  details?: Record<string, unknown>;
}
```

Quando uma operação falha, nada muda: o estado que você passou continua válido e idêntico.

## Operações puras

Todas têm a forma `(state, input, config) => OperationResult` e todas passam pelo pipeline de validação (estrutura → identidade → relacionamentos → validadores). O `input.context`, quando informado, é repassado para `when`, `validate` e os validadores.

| Função | Input | Extra no sucesso | Observações |
|---|---|---|---|
| `registerEntity(state, entity, config)` | `TEntity` | `{ key }` | Falha com `IDENTITY_COLLISION` se a identidade normalizada já existe. |
| `updateEntity(state, { key, data }, config)` | | | Os novos dados precisam resolver para a mesma `key` (senão, `IDENTITY_CHANGE_REQUIRES_REKEY`). Revalida todas as ocorrências. |
| `rekeyEntity(state, { key, data }, config)` | | `{ key }` (a nova chave) | Troca a identidade e atualiza todas as ocorrências. Falha com `IDENTITY_COLLISION` se a nova chave já existe. |
| `removeEntity(state, { key }, config)` | | | `ENTITY_IN_USE` enquanto houver ocorrências, exceto com `entityRemoval: "force"`, que remove as ocorrências e os descendentes delas. |
| `addNode(state, input, config)` | `{ entity \| entityKey, parentId?, relationship, index? }` | `{ nodeId, entityKey }` | `entity` registra a entidade se ela for nova e **reaproveita o cadastro sem alterá-lo** se ela já existir; se os dados forem diferentes do cadastro (comparação rasa), o resultado traz o warning `ENTITY_DATA_IGNORED`. `entityKey` exige uma entidade já registrada. Sem `parentId` (ou com `null`), o nó vira raiz. Sem `index`, entra no fim. |
| `removeNode(state, input, config)` | `{ nodeId, children?: "cascade" \| "reparent", reparentTo? }` | | `cascade` (padrão) remove os descendentes. `reparent` move os filhos para `reparentTo` (padrão: o pai do nó removido, na mesma posição). Nunca apaga o cadastro, exceto com `entityRemoval: "when-unreferenced"`. |
| `moveNode(state, { nodeId, newParentId, index? }, config)` | | | Preserva a entidade e os descendentes. `CYCLE_DETECTED` se o destino for o próprio nó ou um descendente dele. Revalida as regras no destino e a profundidade da subárvore inteira. `index` é a posição na lista de destino depois do movimento. Se a posição não muda, devolve o mesmo estado e nenhum evento. |
| `updateRelationship(state, { nodeId, relationship }, config)` | | | Muda só aquela ocorrência. |

As entradas usam `NoInfer`: os tipos vêm de `state` e `config`, e um literal no `input` não os alarga.

**Imutabilidade.** O estado devolvido é congelado (`Object.freeze`) e é dono do que recebe: entidades e relacionamentos que são objetos simples ou arrays entram como cópia rasa congelada, e instâncias de classe são congeladas no lugar. Mudar depois o objeto que você passou não altera o estado, e mutar o estado lança `TypeError` em modo estrito. O congelamento é raso. Detalhes e custo em [architecture.md](./architecture.md#o-estado-é-dono-do-que-recebe-tes-35--f1).

**Ordem.** `getAllEntities` e `Object.keys(state.nodes)` seguem a ordem de propriedades do JavaScript: chaves que parecem inteiros (`"2"`, `"10"`) vêm primeiro, em ordem numérica. `rootIds` e `childIds` sempre guardam a ordem da estrutura.

## Consultas

| Função | Retorno |
|---|---|
| `findEntity(state, key)` | `EntityRecord \| undefined` (cadastro) |
| `hasEntity(state, key)` | `boolean` |
| `getAllEntities(state)` | `EntityRecord[]` |
| `findByIdentity(state, value, config)` | Cadastro central encontrado pelo valor bruto (normalizado). |
| `findAllByIdentity(state, value, config)` | **Ocorrências** (nós) daquela identidade, em pré-ordem. |
| `getOccurrences(state, key)` | Ocorrências de uma chave já normalizada. |
| `findByNodeId(state, nodeId)` | `StructureNode \| undefined` |
| `findByPath(state, entityKeys)` | Primeiro nó que segue o caminho de chaves a partir das raízes. |
| `searchEntities(state, (entity, key) => boolean)` | `EntityRecord[]` |
| `getParent(state, nodeId)` / `getChildren(state, nodeId \| null)` | `getChildren(state, null)` devolve as raízes. |
| `getAncestors(state, nodeId)` | Do pai mais próximo até a raiz. |
| `getDescendants(state, nodeId)` | Pré-ordem, sem o próprio nó. |
| `getRoot(state, nodeId)` / `getDepth(state, nodeId)` / `getPath(state, nodeId)` | A profundidade das raízes é 0; `getPath` vai da raiz até o nó. |
| `toTree(state, rootId?)` | Visão aninhada `TreeNode[]` com `entity` e `relationship`. |
| `resolveIdentity(entity, config)` / `normalizeIdentity(value, config)` | `Result<EntityKey, ValidationError[]>` |

Todas as travessias são iterativas.

## Regras e validação

| Função | Descrição |
|---|---|
| `validateStructure(state, config, { context? })` | Checa a integridade referencial (incluindo ciclos de `parentId`, com `CYCLE_DETECTED`) e depois roda o pipeline completo. Devolve `{ valid, errors, warnings }`. |
| `validateRelationship(parent, child, config, { relationship?, context? })` | Avalia regras e `validate` para dois `TEntity`. Devolve `ValidationResult`. |
| `canRelate(parent, child, config, options?)` | `boolean` |
| `getAllowedChildren(state, parentKey, config, options?)` | Entidades registradas que podem ser filhas de `parentKey`. |
| `getAllowedParents(state, childKey, config, options?)` | Entidades registradas que podem ser pais de `childKey`. |

A precedência das regras está em [relationship-rules.md](./relationship-rules.md).

## Wrapper com estado: `createEntityStructure`

```ts
const structure = createEntityStructure<Entity, Relationship>(config, { initialState?, onListenerError? });
```

- Cada instância tem o próprio estado; duas instâncias nunca compartilham nada.
- Valida a configuração na hora (`EntityStructureConfigError`). Se receber um `initialState`, ele passa por `validateStructure`, e um estado inválido lança `InvalidStateError` (com `.errors`).
- As mutações aceitam o mesmo `input` das funções puras, sem `state` e `config`, e devolvem o mesmo `OperationResult`. O estado da instância só muda quando o resultado é `ok`.
- Atalhos: `removeNode(nodeId)` e `removeEntity(key)` também aceitam só o id.
- Um `initialState` vindo de fora é assumido como em `importStructure`: o que não está congelado é copiado e congelado, e o seu objeto fica intacto.
- `getState()` devolve o estado atual. `subscribe((state, events) => void)` devolve a função que cancela a inscrição e é chamado só quando o estado muda.
- Os listeners são isolados: se um deles lançar, a mutação continua aplicada, os demais rodam e quem chamou recebe o `Result` normalmente. O erro vai para `onListenerError(error, listener)`, cujo padrão é `console.error`.
- Todas as consultas e as funções de regra acima estão disponíveis sem `state` e `config`, por exemplo `structure.findAllByIdentity(value)` ou `structure.canRelate(parent, child)`.

```ts
const result = structure.addNode({ entity: companyA, relationship: { percentage: 100 } });
if (!result.ok) {
  console.log(result.errors.map((error) => error.code));
} else {
  structure.addNode({ entity: personX, parentId: result.value.nodeId, relationship: { percentage: 60 } });
}
```

## Eventos

`StructureEvent` é uma união discriminada por `type`:

| `type` | Campos |
|---|---|
| `ENTITY_REGISTERED` | `key`, `entity` |
| `ENTITY_UPDATED` | `key`, `previous`, `next` |
| `ENTITY_REKEYED` | `previousKey`, `key`, `previous`, `next`, `nodeIds` |
| `ENTITY_REMOVED` | `key`, `entity` |
| `NODE_ADDED` | `nodeId`, `entityKey`, `parentId`, `index` |
| `NODE_REMOVED` | `nodeId`, `entityKey`, `parentId`, `node` |
| `NODE_MOVED` | `nodeId`, `from: { parentId, index }`, `to: { parentId, index }` |
| `RELATIONSHIP_UPDATED` | `nodeId`, `previous`, `next` |

## Serialização: `exportStructure` / `importStructure`

```ts
const snapshot = exportStructure(state);           // StructureSnapshotV1
const json = JSON.stringify(snapshot);
const result = importStructure(JSON.parse(json), config, { migrations?, context? });
if (result.ok) createEntityStructure(config, { initialState: result.value.state });
```

### Formato `StructureSnapshotV1`

```ts
{
  version: 1,
  entities: [{ key, data }],                                    // ordem do registro
  nodes: [{ id, entityKey, parentId, childIds, relationship }], // lista plana, em pré-ordem a partir das raízes
  rootIds: [...]
}
```

- Só objetos e arrays simples, sem `Map` e sem funções. O snapshot é serializável em JSON na mesma medida em que `TEntity` e `TRelationship` forem.
- `childIds` guarda a ordem dos filhos. `SNAPSHOT_VERSION` é a versão que `exportStructure` grava.
- `exportStructure` não valida e não descarta nada: num estado inválido, os nós inalcançáveis vão no fim de `nodes`.
- Round-trip: `importStructure(JSON.parse(JSON.stringify(exportStructure(s))), config)` devolve um estado equivalente (`toEqual`) a `s`. Um `relationship: undefined` some no JSON e volta como `undefined`.

### Importação

`importStructure(data, config, options?)` recebe dados sem tipo (por exemplo, a saída do `JSON.parse`) e devolve `Result<{ state, warnings, migratedFrom }, ValidationError[]>`. Os estágios rodam nesta ordem:

1. **Versão:** `version` precisa ser um inteiro (`SNAPSHOT_UNSUPPORTED_VERSION`). Uma versão diferente de `SNAPSHOT_VERSION` só é aceita se houver migração para ela.
2. **Migrações:** `options.migrations` é um mapa `{ [versãoDeOrigem]: (snapshot) => snapshotMaisNovo }`, aplicado em cadeia até chegar a `SNAPSHOT_VERSION`. Se a migração lançar uma exceção, devolver algo sem `version` ou voltar a uma versão já vista, o erro é `SNAPSHOT_MIGRATION_FAILED`. `migratedFrom` informa a versão original.
3. **Formato:** os tipos dos campos de `entities`, `nodes` e `rootIds` (`SNAPSHOT_INVALID_FORMAT`). Todos os erros de formato são devolvidos juntos, e a importação para aqui.
4. **Duplicidade no snapshot:** id de nó repetido (`NODE_ID_COLLISION`), chave de entidade repetida e chaves diferentes que colidem depois da normalização da identidade (`IDENTITY_COLLISION`, com `details.resolvedKey` e `details.existingKey`). Nesses casos vale a primeira ocorrência.
5. **Pipeline do core, via `validateStructure`** (não existe um validador paralelo): integridade referencial (entidade, pai, filho ou raiz inexistente → `DANGLING_REFERENCE`; vínculos inconsistentes ou nós inalcançáveis → `INCONSISTENT_LINK`; ciclo de `parentId` → `CYCLE_DETECTED`), seguida de estrutura (`MAX_DEPTH_EXCEEDED`, `IDENTITY_CYCLE`), identidade (`IDENTITY_MISSING`/`INVALID`/`EMPTY`/`MISMATCH`), regras de relacionamento, duplicidade entre irmãos e validadores do consumidor. Os validadores recebem `operation: "validateStructure"` e o `options.context`.

Os erros dos estágios 4 e 5 são devolvidos juntos. Dentro do pipeline vale a mesma regra das operações: os erros de estrutura e de identidade interrompem os estágios seguintes, e os de regras e de validadores aparecem todos juntos. Cada erro traz:

- `nodeId` e/ou `entityKey`, quando se aplicam;
- `path` (ids dos nós, da raiz até `nodeId`), quando o nó está na árvore;
- `details.pointer` (JSON Pointer no snapshot, por exemplo `/nodes/3/parentId`), nos erros de formato e de duplicidade.

Uma configuração inválida lança `EntityStructureConfigError`, como nas outras funções. `data` e `relationship` não são validados quanto ao tipo: para isso, use validadores do consumidor (por exemplo, com um schema).

## Histórico opcional

> **Não é auditoria oficial.** O histórico é um log em memória, opt-in e limitado, pensado para desfazer na UI, para depuração e para telas de "alterações recentes". Ele não persiste nada, não garante integridade nem autoria, pode ser limpo pelo dono e só registra os eventos que recebe. Se você precisa de auditoria, grave os eventos num sistema próprio, no servidor.

O core não registra nada sozinho: as operações puras já devolvem `events`, e o módulo de histórico só os acumula quando você pede.

```ts
const history = createHistory<Entity, Relationship>({ limit: 500 }); // padrão: DEFAULT_HISTORY_LIMIT (1000)
const stop = trackHistory(structure, history, { getContext: () => ({ userId }) });
// ...
history.entries(); // do mais antigo para o mais novo
stop();
```

- `createHistory({ limit?, now?, createId? })`: `limit` é um inteiro positivo ou `Infinity`, e as entradas mais antigas são descartadas quando ele é ultrapassado. `now` (padrão `Date.now`) e `createId` (padrão `h1`, `h2`...) são injetáveis.
- `history.record(events, { context?, state? })` acrescenta uma entrada por evento e devolve as entradas novas. Use para registrar o resultado de funções puras: `history.record(result.value.events, { state: result.value.state, context })`.
- `trackHistory(structure, history, { getContext? })` assina o `subscribe` de um `createEntityStructure` e devolve a função que cancela a assinatura. Operações que falham não geram eventos.
- `history.entries()` devolve uma cópia. `history.clear()` esvazia o log.
- `toHistoryEntries(events, { timestamp, createId, context?, state? })` faz o mapeamento puro, sem acumular.

Campos de `HistoryEntry`:

| Campo | Conteúdo |
|---|---|
| `id`, `type`, `timestamp` | Id da entrada, tipo do evento e horário (as entradas de um mesmo lote têm o mesmo horário) |
| `entityKey` | Chave da entidade. Em `NODE_MOVED` e `RELATIONSHIP_UPDATED`, vem de `state`, quando ele é informado |
| `previousEntityKey` | Só em `ENTITY_REKEYED` |
| `nodeId` | Nos eventos de nó e de relacionamento |
| `from` / `to` | `{ parentId, index? }`: origem e destino em `NODE_MOVED`, destino em `NODE_ADDED`, origem (sem `index`) em `NODE_REMOVED` |
| `before` / `after` | Entidade anterior/nova, relacionamento anterior/novo, ou o nó removido (`before` de `NODE_REMOVED`) |
| `context` | O que o consumidor informou (usuário, motivo, id da requisição...) |
| `event` | O `StructureEvent` original |

## Códigos de erro

`CORE_ERROR_CODES` mapeia cada código para a sua categoria. `isCoreErrorCode(code)` diz se um código é do core.

| Categoria | Códigos |
|---|---|
| `structure` | `NODE_NOT_FOUND`, `PARENT_NOT_FOUND`, `CYCLE_DETECTED`, `NODE_ID_COLLISION`, `INVALID_NODE_ID`, `INVALID_INDEX`, `MAX_DEPTH_EXCEEDED`, `IDENTITY_CYCLE`, `DANGLING_REFERENCE`, `INCONSISTENT_LINK`, `SNAPSHOT_INVALID_FORMAT`, `SNAPSHOT_UNSUPPORTED_VERSION`, `SNAPSHOT_MIGRATION_FAILED` |
| `identity` | `IDENTITY_MISSING`, `IDENTITY_INVALID`, `IDENTITY_EMPTY`, `IDENTITY_COLLISION`, `IDENTITY_MISMATCH`, `IDENTITY_CHANGE_REQUIRES_REKEY`, `ENTITY_NOT_FOUND`, `ENTITY_IN_USE`, `ENTITY_DATA_IGNORED` (só warning, em `addNode`) |
| `relationship` | `RELATIONSHIP_DENIED`, `RELATIONSHIP_NOT_ALLOWED`, `RELATIONSHIP_INVALID`, `SIBLING_DUPLICATE` |
| `domain` | `VALIDATION_FAILED` (padrão dos validadores do consumidor sem `code`) |

Regras de bloqueio e validadores podem definir códigos próprios: o tipo `ErrorCode` é `CoreErrorCode | string`.
