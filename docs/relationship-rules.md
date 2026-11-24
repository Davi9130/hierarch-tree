# Regras de relacionamento

As regras dizem quais vínculos **pai → filho** são permitidos. O core não conhece nenhum tipo de entidade: quem descreve as regras é o consumidor, com base nas propriedades da própria entidade.

```ts
relationships: {
  mode?: "restrictive" | "permissive";        // padrão: "restrictive"
  rules?: RelationshipRule<TEntity, TRelationship>[];
  validate?: (ctx: RelationshipContext<TEntity, TRelationship>) => Verdict; // sempre executado
}
```

## Anatomia de uma regra

```ts
interface RelationshipRule<TEntity, TRelationship> {
  id?: string;                     // vira `ruleId` nos erros; padrão `rule[<índice>]`
  parent?: EntityMatcher<TEntity>; // omitido = qualquer pai
  child?: EntityMatcher<TEntity>;  // omitido = qualquer filho
  when?: (ctx) => boolean;         // condição extra, ex. sobre o relacionamento
  allowed: boolean;
  code?: string;                   // código de erro próprio para uma regra de bloqueio
  message?: string;
}
```

O `EntityMatcher` aceita duas formas:

- **Objeto declarativo** (`{ kind: "unit" }`): cada propriedade é comparada com `===`. Com um array (`{ kind: ["unit", "division"] }`), vale "um de". **Só valores primitivos são aceitos.** Um objeto aninhado faz `EntityStructureConfigError` ser lançado na primeira vez que a configuração é usada, porque comparar objetos de forma rasa é ambíguo.
- **Predicado** (`(entity) => boolean`): para qualquer comparação mais rica.

## Precedência

Para cada vínculo, o core seleciona as regras cujos `parent`, `child` e `when` casam com ele. Depois:

1. Se alguma regra que casou tem `allowed: false`, o vínculo é **bloqueado**, com `RELATIONSHIP_DENIED` ou o `code` da regra. Deny vence allow, qualquer que seja a ordem das regras.
2. Senão, se alguma regra que casou tem `allowed: true`, o vínculo é **permitido**.
3. Senão, nenhuma regra casou e vale o `mode`: `restrictive` bloqueia com `RELATIONSHIP_NOT_ALLOWED`, `permissive` permite.
4. Em **todos** os casos, `validate` roda e pode acrescentar um erro (`RELATIONSHIP_INVALID` ou o `code` que ele devolver) ou, com `severity: "warning"`, só um aviso.

Os erros de regra vêm com `category: "relationship"`, `nodeId` (a ocorrência filha), `path`, `entityKey` e `ruleId`.

## Onde as regras são aplicadas

Em toda mutação, pelo pipeline único:

| Operação | Vínculos reavaliados |
|---|---|
| `addNode` | pai → novo nó |
| `moveNode` | novo pai → nó movido (e a subárvore inteira, para profundidade e ciclos) |
| `updateRelationship` | pai → nó (regras com `when` podem depender do relacionamento) |
| `updateEntity` / `rekeyEntity` | todos os vínculos que entram ou saem de cada ocorrência da entidade |
| `removeNode` com `children: "reparent"` | novo pai → cada filho realocado |
| `validateStructure` | todos os vínculos |

Raízes não têm vínculo, então as regras não se aplicam a elas. Para restringir quem pode ser raiz, use um validador (`config.validators`) que olhe para `parent === null`.

## Contexto recebido por `when` e `validate`

```ts
interface RelationshipContext<TEntity, TRelationship> {
  parent: EntityRecord<TEntity>;
  child: EntityRecord<TEntity>;
  parentNode: StructureNode<TRelationship> | undefined; // undefined nas consultas
  childNode: StructureNode<TRelationship> | undefined;
  relationship: TRelationship | undefined;               // undefined nas consultas sem relationship
  operation: OperationName | "validateStructure" | "query";
  state: StructureState<TEntity, TRelationship> | undefined;
  context: unknown;                                      // `input.context` da operação
}
```

## Consultas de compatibilidade

`canRelate`, `validateRelationship`, `getAllowedChildren` e `getAllowedParents` avaliam só as regras e o `validate`. Duplicidade entre irmãos, ciclos e profundidade dependem de uma operação concreta e não entram nessas consultas.

## Exemplo: estrutura societária (configuração do consumidor)

O exemplo completo está em `examples/corporate-structure.ts` e é exercitado em `tests/relationships.test.ts`.

```ts
const config: EntityStructureConfig<Party, Shareholding> = {
  identity: { key: "taxPayer", normalize: (value) => value.replace(/\D/g, "") },
  relationships: {
    mode: "restrictive",
    rules: [
      { id: "pj-has-pf", parent: { type: "PJ" }, child: { type: "PF" }, allowed: true },
      { id: "pj-has-pj", parent: { type: "PJ" }, child: { type: "PJ" }, allowed: true },
      { id: "pf-has-pf", parent: { type: "PF" }, child: { type: "PF" }, allowed: true },
      { id: "pf-cannot-have-pj", parent: { type: "PF" }, child: { type: "PJ" }, allowed: false, code: "INVALID_SHAREHOLDER" },
    ],
  },
  validators: [percentageLimit], // soma das participações dos filhos ≤ 100%
};
```

| Pai | Filho PF | Filho PJ |
|---|---|---|
| PF | Permitido | Bloqueado (`INVALID_SHAREHOLDER`) |
| PJ | Permitido | Permitido |

Com `mode: "restrictive"`, a regra de bloqueio explícita é redundante: sem ela, PF → PJ já seria bloqueado com `RELATIONSHIP_NOT_ALLOWED`. Ela aparece no exemplo para dar um código e uma mensagem de domínio ao erro.
