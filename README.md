# hierarch-tree

Core genérico em TypeScript, sem dependências de runtime, para estruturas hierárquicas multinível:

- **Identidade configurável:** por propriedade ou por função, com normalização.
- **Cadastro central separado das ocorrências:** a mesma entidade pode aparecer em várias posições, cada ocorrência com o próprio relacionamento.
- **Regras de relacionamento configuráveis:** deny > allow > `mode`, com o validador customizado sempre executado.
- **Operações puras e atômicas** sobre um estado normalizado e imutável, todas passando pelo mesmo pipeline de validação.

O core não conhece nenhum domínio. Conceitos como PF/PJ ficam na configuração do consumidor (veja `examples/corporate-structure.ts`).

```ts
import { createEntityStructure } from "hierarch-tree";

interface Unit { code: string; kind: "division" | "team" }

const structure = createEntityStructure<Unit, { lead: boolean }>({
  identity: { key: "code" },
  relationships: {
    rules: [{ parent: { kind: "division" }, child: { kind: "team" }, allowed: true }],
  },
});

const division = structure.addNode({ entity: { code: "d1", kind: "division" }, relationship: { lead: false } });
if (division.ok) {
  structure.addNode({ entity: { code: "t1", kind: "team" }, parentId: division.value.nodeId, relationship: { lead: true } });
}
structure.toTree();
```

## Documentação

- [Arquitetura (ADR)](docs/architecture.md)
- [API reference](docs/api-reference.md)
- [Regras de relacionamento](docs/relationship-rules.md)

## Desenvolvimento

```sh
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit (strict)
pnpm build       # ESM (tsup) + d.ts (tsc)
```
