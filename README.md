# hierarch-tree

Core genérico em TypeScript, sem dependências de runtime, para estruturas hierárquicas multinível:

- **Identidade configurável:** por propriedade ou por função, com normalização.
- **Cadastro central separado das ocorrências:** a mesma entidade pode aparecer em várias posições, cada ocorrência com o próprio relacionamento.
- **Regras de relacionamento configuráveis:** deny > allow > `mode`, com o validador customizado sempre executado.
- **Operações puras e atômicas** sobre um estado normalizado e imutável, todas passando pelo mesmo pipeline de validação.
- **Importação/exportação versionada** (`exportStructure` / `importStructure`, com migrações) e **histórico opcional** de alterações (não é auditoria).

O core não conhece nenhum domínio. Conceitos como PF/PJ ficam na configuração do consumidor (veja [`examples/corporate-structure.ts`](https://github.com/Davi9130/hierarch-tree/blob/main/examples/corporate-structure.ts)).

## Instalação

```sh
pnpm add hierarch-tree
# adapters opcionais: instale só os peers do que for usar
pnpm add zod              # hierarch-tree/zod (Zod >= 4.3.0)
pnpm add zustand          # hierarch-tree/zustand
pnpm add react react-hook-form  # hierarch-tree/react-hook-form
```

Também dá para instalar direto do GitHub (o script `prepare` gera o `dist/`): `pnpm add github:Davi9130/hierarch-tree`.

## Uso

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

- [Arquitetura (ADR)](https://github.com/Davi9130/hierarch-tree/blob/main/docs/architecture.md)
- [API reference](https://github.com/Davi9130/hierarch-tree/blob/main/docs/api-reference.md)
- [Regras de relacionamento](https://github.com/Davi9130/hierarch-tree/blob/main/docs/relationship-rules.md)
- [Adapter Zod (`hierarch-tree/zod`)](https://github.com/Davi9130/hierarch-tree/blob/main/docs/zod.md): validadores a partir de schemas Zod do consumidor (opcional)
- [Adapter Zustand](https://github.com/Davi9130/hierarch-tree/blob/main/docs/zustand.md) (`hierarch-tree/zustand`, `zustand` como peerDependency opcional)
- [Adapter React Hook Form](https://github.com/Davi9130/hierarch-tree/blob/main/docs/react-hook-form.md) (`hierarch-tree/react-hook-form`, `react` e `react-hook-form` como peerDependencies opcionais): o form guarda o estado normalizado do core, sem segunda fonte de verdade
- [Exemplos](https://github.com/Davi9130/hierarch-tree/blob/main/docs/examples.md): PF/PJ e o fluxo ponta a ponta snapshot → Zod → Zustand / RHF

## Desenvolvimento

```sh
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit (strict)
pnpm build       # ESM (tsup) + d.ts (tsc)
```
- [Changelog](https://github.com/Davi9130/hierarch-tree/blob/main/CHANGELOG.md)

## Publicação (mantenedores)

Primeira versão (`0.1.0`, já em `package.json`), a partir do `main` atualizado:

```sh
npm login
pnpm check                     # typecheck, testes e build (o prepublishOnly roda de novo)
npm pack --dry-run             # deve listar só dist/, README.md, LICENSE, CHANGELOG.md e package.json
npm publish --access public
git tag v0.1.0 && git push origin v0.1.0
```

Próximas versões: atualize o `CHANGELOG.md`, faça commit e rode

```sh
npm version patch              # ou minor / major: altera package.json, faz commit e cria a tag vX.Y.Z
npm publish
git push --follow-tags
```
