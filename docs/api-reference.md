# API reference (core)

Tudo é exportado por `hierarch-tree`. Os genéricos são `TEntity` (dados do cadastro) e `TRelationship` (metadados do vínculo de cada ocorrência).

- [Configuração](#configuração)
- [Estado e resultados](#estado-e-resultados)
- [Operações puras](#operações-puras)
- [Consultas](#consultas)
- [Regras e validação](#regras-e-validação)
- [Wrapper com estado: `createEntityStructure`](#wrapper-com-estado-createentitystructure)
- [Eventos](#eventos)
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

Uma configuração inválida lança `EntityStructureConfigError`. A configuração é resolvida e memoizada por objeto na primeira vez que é usada.

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
| `addNode(state, input, config)` | `{ entity \| entityKey, parentId?, relationship, index? }` | `{ nodeId, entityKey }` | `entity` registra a entidade se ela for nova e **reaproveita o cadastro sem alterá-lo** se ela já existir. `entityKey` exige uma entidade já registrada. Sem `parentId` (ou com `null`), o nó vira raiz. Sem `index`, entra no fim. |
| `removeNode(state, input, config)` | `{ nodeId, children?: "cascade" \| "reparent", reparentTo? }` | | `cascade` (padrão) remove os descendentes. `reparent` move os filhos para `reparentTo` (padrão: o pai do nó removido, na mesma posição). Nunca apaga o cadastro, exceto com `entityRemoval: "when-unreferenced"`. |
| `moveNode(state, { nodeId, newParentId, index? }, config)` | | | Preserva a entidade e os descendentes. `CYCLE_DETECTED` se o destino for o próprio nó ou um descendente dele. Revalida as regras no destino e a profundidade da subárvore inteira. `index` é a posição na lista de destino depois do movimento. Se a posição não muda, devolve o mesmo estado e nenhum evento. |
| `updateRelationship(state, { nodeId, relationship }, config)` | | | Muda só aquela ocorrência. |

As entradas usam `NoInfer`: os tipos vêm de `state` e `config`, e um literal no `input` não os alarga.

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
| `validateStructure(state, config, { context? })` | Checa a integridade referencial e depois roda o pipeline completo. Devolve `{ valid, errors, warnings }`. |
| `validateRelationship(parent, child, config, { relationship?, context? })` | Avalia regras e `validate` para dois `TEntity`. Devolve `ValidationResult`. |
| `canRelate(parent, child, config, options?)` | `boolean` |
| `getAllowedChildren(state, parentKey, config, options?)` | Entidades registradas que podem ser filhas de `parentKey`. |
| `getAllowedParents(state, childKey, config, options?)` | Entidades registradas que podem ser pais de `childKey`. |

A precedência das regras está em [relationship-rules.md](./relationship-rules.md).

## Wrapper com estado: `createEntityStructure`

```ts
const structure = createEntityStructure<Entity, Relationship>(config, { initialState? });
```

- Cada instância tem o próprio estado; duas instâncias nunca compartilham nada.
- Valida a configuração na hora (`EntityStructureConfigError`). Se receber um `initialState`, ele passa por `validateStructure`, e um estado inválido lança `InvalidStateError` (com `.errors`).
- As mutações aceitam o mesmo `input` das funções puras, sem `state` e `config`, e devolvem o mesmo `OperationResult`. O estado da instância só muda quando o resultado é `ok`.
- Atalhos: `removeNode(nodeId)` e `removeEntity(key)` também aceitam só o id.
- `getState()` devolve o estado atual. `subscribe((state, events) => void)` devolve a função que cancela a inscrição e é chamado só quando o estado muda.
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

## Códigos de erro

`CORE_ERROR_CODES` mapeia cada código para a sua categoria. `isCoreErrorCode(code)` diz se um código é do core.

| Categoria | Códigos |
|---|---|
| `structure` | `NODE_NOT_FOUND`, `PARENT_NOT_FOUND`, `CYCLE_DETECTED`, `NODE_ID_COLLISION`, `INVALID_NODE_ID`, `INVALID_INDEX`, `MAX_DEPTH_EXCEEDED`, `IDENTITY_CYCLE`, `DANGLING_REFERENCE`, `INCONSISTENT_LINK` |
| `identity` | `IDENTITY_MISSING`, `IDENTITY_INVALID`, `IDENTITY_EMPTY`, `IDENTITY_COLLISION`, `IDENTITY_MISMATCH`, `IDENTITY_CHANGE_REQUIRES_REKEY`, `ENTITY_NOT_FOUND`, `ENTITY_IN_USE` |
| `relationship` | `RELATIONSHIP_DENIED`, `RELATIONSHIP_NOT_ALLOWED`, `RELATIONSHIP_INVALID`, `SIBLING_DUPLICATE` |
| `domain` | `VALIDATION_FAILED` (padrão dos validadores do consumidor sem `code`) |

Regras de bloqueio e validadores podem definir códigos próprios: o tipo `ErrorCode` é `CoreErrorCode | string`.
