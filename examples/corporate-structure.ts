/**
 * Example domain configuration: a shareholding structure with natural persons
 * (PF) and legal entities (PJ). None of this lives in the core; it is plain
 * consumer configuration.
 */
import type { EntityStructureConfig, StructureValidator } from "../src/index.js";

export interface Party {
  taxPayer: string;
  type: "PF" | "PJ";
  name: string;
}

export interface Shareholding {
  percentage: number;
  role?: string;
}

/** The sum of the children's percentages of a node cannot exceed 100%. */
export const percentageLimit: StructureValidator<Party, Shareholding> = ({ children }) => {
  const total = children.reduce((sum, child) => sum + child.relationship.percentage, 0);
  return total > 100
    ? { valid: false, code: "PERCENTAGE_EXCEEDED", message: `Shares add up to ${total}%.`, details: { total } }
    : { valid: true };
};

export function corporateConfig(
  overrides: Partial<EntityStructureConfig<Party, Shareholding>> = {},
): EntityStructureConfig<Party, Shareholding> {
  return {
    identity: { key: "taxPayer", normalize: (value) => value.replace(/\D/g, "") },
    relationships: {
      mode: "restrictive",
      rules: [
        { id: "pj-has-pf", parent: { type: "PJ" }, child: { type: "PF" }, allowed: true },
        { id: "pj-has-pj", parent: { type: "PJ" }, child: { type: "PJ" }, allowed: true },
        { id: "pf-has-pf", parent: { type: "PF" }, child: { type: "PF" }, allowed: true },
        {
          id: "pf-cannot-have-pj",
          parent: { type: "PF" },
          child: { type: "PJ" },
          allowed: false,
          code: "INVALID_SHAREHOLDER",
          message: "A natural person cannot hold a legal entity in this structure.",
        },
      ],
    },
    validators: [percentageLimit],
    ...overrides,
  };
}

export const companyA: Party = { taxPayer: "11.111.111/0001-11", type: "PJ", name: "Company A" };
export const companyB: Party = { taxPayer: "22.222.222/0001-22", type: "PJ", name: "Company B" };
export const personX: Party = { taxPayer: "333.333.333-33", type: "PF", name: "Person X" };
export const personY: Party = { taxPayer: "444.444.444-44", type: "PF", name: "Person Y" };
