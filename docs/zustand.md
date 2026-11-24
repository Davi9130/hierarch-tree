# Adapter Zustand (`hierarch-tree/zustand`)

Adapter opcional que guarda o estado do core numa store **vanilla** do Zustand. Ele não tem lógica de domínio nem validação própria: cada ação chama a função pura correspondente do core e só faz `set` quando a operação dá certo.

```sh
pnpm add hierarch-tree zustand   # zustand >= 5 é peerDependency opcional
```

O pacote principal (`hierarch-tree`) nunca importa `zustand`. Quem não usa o adapter não precisa instalar.

## Criando a store

```ts
import { createEntityStructureStore } from "hierarch-tree/zustand";
import type { EntityStructureConfig } from "hierarch-tree";

interface Party {
  taxPayer: string;
  type: "PF" | "PJ";
  name: string;
}
interface Shareholding {
  percentage: number;
  role?: string;
}

const config: EntityStructureConfig<Party, Shareholding> = {
  identity: { key: "taxPayer", normalize: (value) => value.replace(/\D/g, "") },
  relationships: {
    rules: [
      { parent: { type: "PJ" }, child: { type: "PF" }, allowed: true },
      { parent: { type: "PJ" }, child: { type: "PJ" }, allowed: true },
      { parent: { type: "PF" }, child: { type: "PF" }, allowed: true },
    ],
  },
};

const store = createEntityStructureStore<Party, Shareholding>({ config });
```

- **Uma store por chamada.** Não existe singleton: duas chamadas com a mesma `config` geram stores totalmente independentes (estado, assinaturas e cache de seletores).
- `initialData` (opcional) aceita um `StructureState` do core (verificado com `validateStructure`) ou um snapshot de `exportStructure` (carregado com `importStructure`; passe `importOptions` para migrações/contexto). Dado inválido lança `InvalidStateError` com todos os erros; `config` inválida lança `EntityStructureConfigError`.

### Formato do estado

```ts
interface EntityStructureStoreState<TEntity, TRelationship> {
  structure: StructureState<TEntity, TRelationship>; // único estado de dados: o do core
  lastEvents: readonly StructureEvent<TEntity, TRelationship>[]; // eventos da última mutação bem-sucedida
  config: EntityStructureConfig<TEntity, TRelationship>;
  actions: EntityStructureActions<TEntity, TRelationship>; // objeto estável
}
```

Estado de UI (seleção, nós expandidos etc.) não faz parte do adapter. Se precisar, mantenha numa store separada ou num slice seu, referenciando `NodeId`s.

## Ações

Todas devolvem exatamente o `OperationResult` do core (`{ ok: true, value: { state, events, warnings, ... } }` ou `{ ok: false, errors }`).

| Ação | Função do core |
|---|---|
| `registerEntity(entity)` | `registerEntity` |
| `updateEntity({ key, data })` | `updateEntity` |
| `rekeyEntity({ key, data })` | `rekeyEntity` |
| `removeEntity(key \| { key, ... })` | `removeEntity` |
| `addNode(input)` | `addNode` |
| `removeNode(nodeId \| { nodeId, ... })` | `removeNode` |
| `moveNode({ nodeId, newParentId, index? })` | `moveNode` |
| `updateRelationship({ nodeId, relationship })` | `updateRelationship` |
| `replaceStructure(state)` | `validateStructure` (devolve o `ValidationResult`) |
| `importSnapshot(data, options?)` | `importStructure` |

Garantias:

- **Falhou, nada muda.** Com erro, a store mantém o mesmo objeto de estado (`store.getState()` continua `===`) e os assinantes **não** são notificados.
- **Sem mudança, sem notificação.** Se a operação dá certo mas devolve o mesmo `StructureState`, não há `set`.
- Os nós, cadastros e listas que a operação não tocou mantêm a referência (copy-on-write do core).

```ts
const { actions } = store.getState();

const company = actions.addNode({
  entity: { taxPayer: "11.111.111/0001-11", type: "PJ", name: "Company A" },
  relationship: { percentage: 100 },
});
if (!company.ok) throw new Error(company.errors.map((error) => error.message).join("\n"));

const partner = actions.addNode({
  entity: { taxPayer: "333.333.333-33", type: "PF", name: "Person X" },
  parentId: company.value.nodeId,
  relationship: { percentage: 60, role: "partner" },
});

// PF não pode ter PJ: a store não muda e os erros vêm no resultado.
const invalid = actions.addNode({
  entity: { taxPayer: "22.222.222/0001-22", type: "PJ", name: "Company B" },
  parentId: partner.ok ? partner.value.nodeId : null,
  relationship: { percentage: 10 },
});
invalid.ok; // false
```

## Seletores

```ts
import {
  selectActions,
  selectAllByIdentity,
  selectChildren,
  selectEntity,
  selectNode,
  selectRootIds,
  selectStructure,
} from "hierarch-tree/zustand";
```

| Seletor | Retorno |
|---|---|
| `selectStructure` | o `StructureState` inteiro |
| `selectActions` | as ações (objeto estável) |
| `selectRootIds` | `readonly NodeId[]` das raízes |
| `selectNode(nodeId)` | `StructureNode \| undefined` |
| `selectEntity(key)` | `EntityRecord \| undefined` (chave já normalizada) |
| `selectChildren(nodeId \| null)` | filhos do nó, ou as raízes com `null` |
| `selectAllByIdentity(value)` | todas as ocorrências da identidade (valor bruto, normalizado com a `config` da store), em pré-ordem |

Todos preservam a referência enquanto o dado lido não muda. Os seletores de lista (`selectChildren`, `selectAllByIdentity`) guardam o último resultado num cache **por store** e devolvem o mesmo array sempre que os itens forem os mesmos nós. Por isso dá para criar o seletor inline, sem `useShallow`:

```tsx
import { useStore } from "zustand";
import { selectChildren, selectNode, type EntityStructureStore } from "hierarch-tree/zustand";

function NodeRow({ store, nodeId }: { store: EntityStructureStore<Party, Shareholding>; nodeId: string }) {
  const node = useStore(store, selectNode(nodeId));
  const children = useStore(store, selectChildren(nodeId)); // re-renderiza só quando os filhos mudam
  const entity = useStore(store, (state) => (node ? state.structure.entities[node.entityKey] : undefined));
  if (!node || !entity) return null;
  return (
    <li>
      {entity.data.name} — {node.relationship.percentage}%
      <ul>
        {children.map((child) => (
          <NodeRow key={child.id} store={store} nodeId={child.id} />
        ))}
      </ul>
    </li>
  );
}
```

Para criar uma store por componente, use `useState(() => createEntityStructureStore({ config }))` (ou `useRef`), não uma variável de módulo.

Visões derivadas que sempre geram objetos novos (`toTree`, `getDescendants` etc.) não têm seletor próprio: derive a partir de `selectStructure` com `useMemo`.

```ts
import { toTree } from "hierarch-tree";
const structure = useStore(store, selectStructure);
const tree = useMemo(() => toTree(structure), [structure]);
```

## Exemplo completo

`examples/zustand-store.ts` é checado pelo `pnpm typecheck` e executado pelos testes (`tests/adapters/zustand.test.ts`).
