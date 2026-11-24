## Exemplos

Todos os exemplos estão em `examples/` e entram no `pnpm typecheck` (o `tsconfig.json` inclui `examples`). Os testes importam deles, então um exemplo que deixar de compilar ou de funcionar quebra o `pnpm check`.

| Arquivo | O que mostra | Coberto por |
|---|---|---|
| `examples/corporate-structure.ts` | Configuração PF/PJ do consumidor: identidade por `taxPayer` normalizada, regras `restrictive` (PJ→PF, PJ→PJ, PF→PF permitidos; PF→PJ bloqueado com `INVALID_SHAREHOLDER`) e o validador de domínio `percentageLimit` (soma das participações dos filhos ≤ 100%). | `tests/relationships.test.ts`, `tests/adversarial/*` |
| `examples/corporate-zod.ts` | O mesmo domínio com schemas Zod do consumidor (`partySchema`, `shareholdingSchema`) ligados por `zodEntityValidator` / `zodRelationshipValidator`. | `tests/adapters/zod.test.ts`, `tests/integration/*` |
| `examples/zustand-store.ts` | Uma store Zustand por estrutura, ações que devolvem `Result` e seletores. Veja [zustand.md](zustand.md). | `tests/adapters/zustand.test.ts` |
| `examples/react-hook-form.tsx` | Formulário recursivo em que o valor do form é o estado normalizado do core, com `createStructureResolver` no submit. Veja [react-hook-form.md](react-hook-form.md). | `tests/adapters/react-hook-form.test.tsx` |

O core não conhece PF nem PJ: esses conceitos só existem nesses arquivos de exemplo.

## Fluxo ponta a ponta: snapshot → Zod → Zustand ou RHF

`tests/integration/corporate-end-to-end.test.tsx` executa este fluxo com o exemplo societário.

```ts
import { exportStructure, importStructure } from "hierarch-tree";
import { createStructureSnapshotSchema, parseStructureSnapshot } from "hierarch-tree/zod";
import { createEntityStructureStore } from "hierarch-tree/zustand";
import { createStructureResolver, useEntityStructureForm } from "hierarch-tree/react-hook-form";

// 1. JSON vindo do backend -> formato + dados do consumidor conferidos pelo Zod.
const snapshotSchema = createStructureSnapshotSchema({ entity: partySchema, relationship: shareholdingSchema });
const parsed = parseStructureSnapshot(JSON.parse(json), snapshotSchema);
if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join("\n"));

const config = corporateZodConfig();

// 2a. Estado em uma store Zustand (o snapshot passa por `importStructure`, com o pipeline completo).
const store = createEntityStructureStore({ config, initialData: parsed.value });

// 2b. Ou direto em um formulário (dentro de um componente React).
const form = useEntityStructureForm({ config, defaultValues: parsed.value, resolver: createStructureResolver(config) });

// 3. Salvar: o estado é um `StructureState` comum.
const saved = JSON.stringify(exportStructure(store.getState().structure));
```

Pontos que o teste confirma:

- Pular o `parseStructureSnapshot` não contorna o domínio: o `importStructure` roda os mesmos validadores Zod e regras, e a store ou o form lançam `InvalidStateError` com dados inválidos.
- A mesma pessoa pode aparecer sob duas empresas. Há um único cadastro central, e cada ocorrência tem a própria participação e os próprios filhos (`getDescendants` de uma ocorrência não inclui os filhos de outra ocorrência da mesma entidade).
- Operações inválidas (PF→PJ, schema Zod, soma > 100%, ciclo estrutural ou por identidade) devolvem erro e mantêm o estado anterior idêntico por referência.
- No formulário, o erro de schema de uma entidade aparece em `errors.nodes[nodeId]` de **cada ocorrência** dela, porque os validadores rodam sobre ocorrências.
- As mesmas operações sobre o mesmo snapshot produzem o mesmo estado no Zustand e no RHF.

## Zod e `exactOptionalPropertyTypes`

Com `exactOptionalPropertyTypes` ligado (como neste repositório), `z.string().optional()` gera `role?: string | undefined`. Esse tipo não é atribuível a uma interface `role?: string`, e por isso o resultado de `parseStructureSnapshot` não entra em `createEntityStructureStore<Party, Shareholding>`. Use `z.string().exactOptional()` (disponível a partir do Zod 4.3.0, o mínimo do peer), como em `examples/corporate-zod.ts`, ou declare a interface com `role?: string | undefined`.
