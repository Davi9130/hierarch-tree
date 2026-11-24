# Adapter React Hook Form (`hierarch-tree/react-hook-form`)

Adapter opcional que liga o core ao React Hook Form (RHF) sem criar uma segunda fonte de verdade. **O valor do formulário é o próprio `StructureState` do core**, normalizado:

```ts
{
  entities: { [entityKey]: { key, data } },                                // cadastro central, uma vez só
  nodes:    { [nodeId]: { id, entityKey, parentId, childIds, relationship } }, // ocorrências
  rootIds:  [nodeId, ...],
}
```

```sh
pnpm add hierarch-tree react react-hook-form   # react >= 18 e react-hook-form ^7.92 são peerDependencies opcionais
```

O pacote principal (`hierarch-tree`) nunca importa `react` nem `react-hook-form`.

## Decisão: por que o form guarda o estado normalizado (spike do TES-33)

Foram avaliadas duas formas:

- **A: estado normalizado no form (escolhida).** Os campos ficam em caminhos estáveis, com chave por id: `nodes.<nodeId>.relationship.percentage` e `entities.<entityKey>.data.name`. Para mover um nó, basta reescrever `parentId` e as duas listas `childIds`. O relacionamento e o cadastro, que já estão no form com o que o usuário digitou, não são tocados.
- **B: árvore aninhada com `useFieldArray` recursivo** (`children.0.children.1...`). Para mover entre pais, é preciso fazer `remove` em um array e `insert` em outro, copiando os valores da subárvore à mão. O `field.id` muda, a subárvore remonta e os erros, `dirty` e `touched`, que ficam por índice, apontam para o nó errado depois de qualquer inserção. Pior: o cadastro de uma entidade com duas ocorrências ficaria duplicado em cada posição. Isso contraria o requisito de cadastro único e obriga a manter uma área normalizada à parte, ou seja, duas fontes de verdade. Também seria preciso converter árvore → core em toda operação.

O critério era mover entre listas sem perder valores e sem `useEffect` de sincronização. Só a opção A atende sem código de sincronização. Os testes `tests/adapters/react-hook-form.test.tsx` (cenário F) comprovam isso.

## Uso

O exemplo completo e type-checked está em `examples/react-hook-form.tsx`:

```tsx
import { Controller, FormProvider, useFormContext, useFormState } from "react-hook-form";
import {
  createStructureResolver,
  useEntityStructureForm,
  useStructureChildren,
  type StructureChild,
  type StructureFormValues,
} from "hierarch-tree/react-hook-form";

type Values = StructureFormValues<Party, Shareholding>;
const resolver = createStructureResolver(config); // pipeline completo do core no submit

function Occurrence({ child }: { child: StructureChild }) {
  const form = useFormContext<Values>();
  const children = useStructureChildren<Party, Shareholding>(child.nodeId);
  const { errors } = useFormState({ control: form.control, name: child.path });
  const error = errors.nodes?.[child.nodeId];
  return (
    <li>
      {/* cadastro: compartilhado por todas as ocorrências → campo controlado */}
      <Controller control={form.control} name={`${child.entityPath}.name`}
        render={({ field }) => <input {...field} />} />
      {/* vínculo: próprio desta ocorrência */}
      <input type="number" {...form.register(`${child.relationshipPath}.percentage`, { valueAsNumber: true })} />
      {error?.message !== undefined && <span role="alert">{error.message}</span>}
      <ul>{children.map((c) => <Occurrence key={c.nodeId} child={c} />)}</ul>
    </li>
  );
}

export function ShareholdingForm({ initial, onSave }: { initial: StructureState<Party, Shareholding>; onSave: (v: Values) => void }) {
  const form = useEntityStructureForm<Party, Shareholding>({ config, defaultValues: initial, resolver });
  const roots = useStructureChildren<Party, Shareholding>(null, { control: form.control });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSave)}>
        <ul>{roots.map((r) => <Occurrence key={r.nodeId} child={r} />)}</ul>
        <button type="button" onClick={() => form.moveNode({ nodeId: "…", newParentId: "…" })}>Mover</button>
      </form>
    </FormProvider>
  );
}
```

## API

### `useEntityStructureForm({ config, defaultValues?, importOptions?, ...useFormProps })`

- `defaultValues`: um `StructureState` (checado com `validateStructure`) ou um snapshot de `exportStructure` (carregado com `importStructure`). É lido só na primeira renderização. Dados inválidos lançam `InvalidStateError`.
- Aceita as outras opções do `useForm` (`mode`, `resolver`, `shouldUnregister`...), exceto `values`, que criaria uma segunda fonte de verdade externa.

Retorna tudo o que o `useForm` retorna (`control`, `register`, `watch`, `getValues`, `setValue`, `reset`, `handleSubmit`, `formState`...) mais:

| Membro | O que faz |
| --- | --- |
| `addNode`, `removeNode`, `moveNode`, `updateRelationship` | Operação pura do core sobre os valores atuais. Em sucesso, grava só os caminhos alterados. Devolve o mesmo `OperationResult` do core. Em erro, o form não muda. |
| `registerEntity`, `updateEntity`, `rekeyEntity`, `removeEntity` | Idem, para o cadastro central. `updateEntity` reflete em todas as ocorrências, porque elas leem o mesmo `entities.<key>.data`. |
| `validateStructure(options?)` | Pipeline completo sobre os valores atuais, inclusive o que foi digitado. |
| `getNode(id)`, `findByIdentity(value)`, `findAllByIdentity(value)`, `toTree(rootId?)`, `getState()` | Leituras sobre os valores atuais. Trate o resultado como somente leitura. |
| `importSnapshot(data, options?)` | `importStructure` + `reset`. Em erro, devolve os erros e nada muda. |
| `reset(values?, options?)` | Mesma assinatura do RHF, mas valida antes e lança `InvalidStateError` se os valores não formarem uma estrutura válida. `reset()` sem argumentos volta aos `defaultValues`. |

### `useStructureChildren(parentId, { control? })`

Retorna os filhos de `parentId` (as raízes quando `null`) como `{ nodeId, entityKey, index, path, relationshipPath, entityPath }[]`. Por padrão, usa o `control` do `FormProvider`. Assina com `useWatch` apenas `nodes.<parentId>.childIds` e o `entityKey` de cada filho, então digitar em outro campo não renderiza a lista de novo.

### `createStructureResolver(config, { context? })`

Resolver para o `useForm`: roda `validateStructure` no submit (e na revalidação), então o `handleSubmit` só chama `onValid` com uma estrutura válida. Os erros ficam em `errors.nodes[nodeId]`, `errors.entities[entityKey]` ou `errors.root`, com `type` igual ao código do core e todos os códigos daquele lugar em `types`.

Helpers de caminho: `nodePath`, `childIdsPath`, `relationshipPath`, `entityPath`, `entityDataPath`.

## Três identificadores, sem mistura

| | O que é | Onde aparece |
| --- | --- | --- |
| `field.id` | id interno do `useFieldArray` | **não existe aqui**: o adapter não usa `useFieldArray`, então não há colisão com `id` nem necessidade de `keyName` (que, aliás, está depreciado no RHF 7) |
| `node.id` | a ocorrência | chave dos caminhos `nodes.<nodeId>...` e `key` do React |
| `entity.key` | a identidade central | chave dos caminhos `entities.<entityKey>...` |

## Quais métodos do RHF o adapter usa

| Método | Quando |
| --- | --- |
| `setValue(path, value, { shouldDirty: true })` | Em toda operação estrutural bem-sucedida, só nos caminhos que mudaram. Nó novo: `nodes.<id>`. Nó movido: `nodes.<id>.parentId` + `childIds` do pai antigo e do novo (ou `rootIds`). Relacionamento: `nodes.<id>.relationship`. Cadastro novo: `entities.<key>`. Cadastro alterado: `entities.<key>.data`. O RHF compara com `deepEqual` antes de gravar, então valor igual não renderiza. |
| `unregister(path, { keepDefaultValue: true })` | Para remover `nodes.<id>` / `entities.<key>`, junto com os inputs, erros e `dirty`/`touched` registrados embaixo. Os `defaultValues` ficam intactos, então `reset()` continua válido. |
| `reset(state)` | `reset` validado e `importSnapshot`. |
| `append` / `remove` / `insert` / `move` / `replace` | **Nunca.** As listas são `childIds` (ids), e os valores de cada nó ficam no caminho do próprio id, não em posição de array. |

As gravações de criação e alteração vêm antes das remoções. Quando o RHF já descartou o objeto `nodes` ou `entities` (ele faz isso ao remover a última chave), o adapter grava o objeto inteiro. Isso evita que o RHF crie um array só porque a primeira chave parece numérica, como uma chave `"11111111000111"` vinda de um CNPJ normalizado.

## Limitações e cuidados

- **Ids e chaves precisam ser segmentos de caminho válidos no RHF:** não podem ser vazios nem conter `.`, `[`, `]`, aspas, nem ser `__proto__`/`constructor`/`prototype`. Uma operação que criaria um id ou uma chave assim falha com `FIELD_PATH_UNSAFE`, e o form não muda. `defaultValues`/`reset` com esses valores lançam `InvalidStateError`. Normalize a identidade (por exemplo, `normalize: (v) => v.replace(/\D/g, "")`).
- **Campos do cadastro compartilhado devem ser controlados** (`Controller`/`useController`). O RHF guarda um único elemento DOM por nome com `register`, então um `<input {...register(...)}>` repetido em duas ocorrências não refletiria a digitação na outra.
- **Digitar não passa pelo pipeline do core**, porque o form é o rascunho. Use `createStructureResolver` (ou `validateStructure()`) no submit. Não edite o campo de identidade com `register`: trocar a identidade é `rekeyEntity`. Se alguém editar mesmo assim, `validateStructure` acusa `IDENTITY_MISMATCH`.
- Cada operação estrutural lê os valores atuais com `getValues()` e faz uma ou mais chamadas a `setValue`, que o React agrupa numa única renderização dentro de handlers.
- Versão testada: `react-hook-form` 7.92 com React 19 (jsdom + `@testing-library/react`).
