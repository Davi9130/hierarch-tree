# Adapter Zod (`hierarch-tree/zod`)

Adapter opcional que transforma **schemas Zod do consumidor** em validadores do pipeline do core e valida snapshots antes do `importStructure`.

- O core não importa o adapter nem o `zod`: quem não usa o subpath `hierarch-tree/zod` não precisa ter o `zod` instalado.
- `zod` é `peerDependency` **opcional** (`^4.0.0`). Aceita schemas do Zod 4 clássico (`zod`) e do `zod/mini`.
- A biblioteca não traz nenhum schema de domínio. O exemplo PF/PJ abaixo está em `examples/corporate-zod.ts`.

```sh
pnpm add hierarch-tree zod
```

## Validadores de entidade e de relacionamento

```ts
import { z } from "zod";
import { createEntityStructure, type EntityStructureConfig } from "hierarch-tree";
import { zodEntityValidator, zodRelationshipValidator } from "hierarch-tree/zod";

interface Party { taxPayer: string; type: "PF" | "PJ"; name: string }
interface Shareholding { percentage: number; role?: string }

const partySchema = z.object({
  taxPayer: z.string().min(1),
  type: z.enum(["PF", "PJ"]),
  name: z.string().min(2, "O nome precisa ter ao menos 2 caracteres."),
});

const shareholdingSchema = z.object({
  percentage: z.number().min(0).max(100),
  role: z.string().optional(),
});

const config: EntityStructureConfig<Party, Shareholding> = {
  identity: { key: "taxPayer", normalize: (value) => value.replace(/\D/g, "") },
  relationships: { mode: "permissive" },
  validators: [zodEntityValidator(partySchema), zodRelationshipValidator(shareholdingSchema)],
};

const structure = createEntityStructure(config);

const root = structure.addNode({
  entity: { taxPayer: "11.111.111/0001-11", type: "PJ", name: "Company A" },
  relationship: { percentage: 100 },
});

if (root.ok) {
  const result = structure.addNode({
    entity: { taxPayer: "333.333.333-33", type: "PF", name: "X" },
    parentId: root.value.nodeId,
    relationship: { percentage: 40 },
  });
  // result.ok === false e o estado não mudou:
  // result.errors[0] = {
  //   code: "ENTITY_SCHEMA_INVALID",
  //   category: "domain",
  //   message: "O nome precisa ter ao menos 2 caracteres.",
  //   nodeId: "<id da nova ocorrência>",
  //   entityKey: "33333333333",
  //   path: ["<id da raiz>", "<id da nova ocorrência>"],
  //   details: { source: "entity", path: ["name"], zodCode: "too_small" },
  // }
}
```

Os dois validadores são `StructureValidator` comuns. Eles entram em `validators` junto com os validadores de domínio do consumidor (como o `percentageLimit` do exemplo) e passam pelo mesmo pipeline do core. Por isso, nenhuma operação consegue contorná-los.

| Validador | Valida | Operações que ele bloqueia |
| --- | --- | --- |
| `zodEntityValidator(schema, options?)` | `node.entity`, o cadastro central de cada ocorrência afetada | `addNode`, `updateEntity` (em todas as ocorrências), `rekeyEntity`, `moveNode`, `importStructure` e `validateStructure` |
| `zodRelationshipValidator(schema, options?)` | `node.relationship`, o vínculo de cada ocorrência afetada | `addNode`, `updateRelationship`, `moveNode`, `importStructure` e `validateStructure` |

### Mapeamento de `ZodIssue` para `ValidationError`

Cada issue do Zod vira **um** `ValidationError`:

| Campo | Origem |
| --- | --- |
| `code` | `ENTITY_SCHEMA_INVALID` ou `RELATIONSHIP_SCHEMA_INVALID` (`ZOD_ERROR_CODES`), ou o `options.code` |
| `message` | `issue.message`, ou seja, a mensagem definida no schema |
| `category` | `"domain"` |
| `nodeId`, `entityKey` | a ocorrência validada (preenchido pelo core) |
| `path` | ids das ocorrências da raiz até o nó (preenchido pelo core, igual aos outros erros) |
| `details.path` | caminho **dentro** da entidade ou do relacionamento (`issue.path`, por exemplo `["address", "zip"]`) |
| `details.zodCode` | `issue.code` (por exemplo `"too_small"`) |
| `details.source` | `"entity"` ou `"relationship"` |

Quando a mesma entidade aparece em várias posições, um `updateEntity` inválido gera um erro por ocorrência, cada um com o próprio `nodeId` e `path`.

### Opções

- `code`: código usado no lugar do padrão.
- `severity: "warning"`: reporta as issues em `warnings` sem bloquear a operação.
- `skipRoots` (só em `zodRelationshipValidator`): não valida o relacionamento das raízes, que não têm pai. O padrão é `false`, então as raízes também precisam satisfazer o schema.

### Limitação

Os validadores rodam sobre **ocorrências**. Uma entidade cadastrada só com `registerEntity`, sem nenhuma ocorrência, não é validada até ser colocada na estrutura. Para validar antes, use o schema direto (`partySchema.parse(entity)`).

## Snapshot: validar antes do `importStructure`

```ts
import { exportStructure, importStructure } from "hierarch-tree";
import { createStructureSnapshotSchema, parseStructureSnapshot } from "hierarch-tree/zod";

const json: unknown = JSON.parse(JSON.stringify(exportStructure(structure.getState())));

// Só o formato (ids, listas, `data` presente):
const formatOnly = parseStructureSnapshot(json);

// Formato + dados do consumidor:
const snapshotSchema = createStructureSnapshotSchema({ entity: partySchema, relationship: shareholdingSchema });
const parsed = parseStructureSnapshot(json, snapshotSchema);

if (parsed.ok) {
  const imported = importStructure(parsed.value, config); // ainda roda o pipeline completo do core
} else {
  // parsed.errors[i] = {
  //   code: "SNAPSHOT_INVALID_FORMAT",
  //   category: "structure",
  //   message: "nodes.3.relationship.percentage: Invalid input: expected number, received string",
  //   nodeId: "<id do nó no snapshot>",
  //   details: {
  //     source: "snapshot",
  //     path: ["nodes", 3, "relationship", "percentage"],
  //     pointer: "/nodes/3/relationship/percentage",
  //     zodCode: "invalid_type",
  //   },
  // }
}
```

- `structureSnapshotSchema`: schema pronto, só de formato, da versão 1 (`StructureSnapshotV1`).
- `createStructureSnapshotSchema({ entity, relationship })`: mesmo formato, validando também `entities[].data` e `nodes[].relationship`. Passe `z.unknown()` no lado que não quiser validar.
- `parseStructureSnapshot(data, schema?)`: devolve `Result<StructureSnapshotV1, ValidationError[]>`. Os erros seguem o formato do `importStructure`: `details.pointer` é um JSON Pointer para o snapshot, e `nodeId` / `entityKey` são preenchidos quando a issue está dentro de um nó ou de uma entidade.
- `snapshotIssuesToErrors(data, issues)`: o mapeamento usado por `parseStructureSnapshot`, para quem chama `safeParse` direto.

O schema cobre só a versão atual (`SNAPSHOT_VERSION = 1`). Snapshots antigos precisam passar pelas `migrations` do `importStructure`, e as chaves desconhecidas são removidas do valor parseado. A validação do schema não substitui a do core: referências, ciclos, identidades e regras de relacionamento continuam sendo checadas no `importStructure`.
