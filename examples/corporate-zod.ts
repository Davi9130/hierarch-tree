/**
 * Example: the shareholding domain from `corporate-structure.ts` validated
 * with consumer-defined Zod schemas. The library ships no domain schema.
 */
import { z } from "zod";
import { zodEntityValidator, zodRelationshipValidator } from "../src/adapters/zod/index.js";
import type { EntityStructureConfig } from "../src/index.js";
import { corporateConfig, percentageLimit, type Party, type Shareholding } from "./corporate-structure.js";

export const partySchema = z.object({
  taxPayer: z.string().min(1),
  type: z.enum(["PF", "PJ"]),
  name: z.string().min(2, "O nome precisa ter ao menos 2 caracteres."),
});

export const shareholdingSchema = z.object({
  percentage: z.number().min(0).max(100),
  role: z.string().optional(),
});

export function corporateZodConfig(
  overrides: Partial<EntityStructureConfig<Party, Shareholding>> = {},
): EntityStructureConfig<Party, Shareholding> {
  return corporateConfig({
    validators: [zodEntityValidator(partySchema), zodRelationshipValidator(shareholdingSchema), percentageLimit],
    ...overrides,
  });
}
