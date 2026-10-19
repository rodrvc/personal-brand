import { toCheckRules } from "@personal-brand/storage/rules";
import type { BrandRuleRepository } from "@personal-brand/storage/contracts";

import { rulesVerifyPolicy, type VerifyPolicy } from "./verify-slides.js";

/** The verification policy of a stored brand: its enabled rules, turned into `runChecks` rules. */
export async function loadStoredVerifyPolicy(rules: BrandRuleRepository, brandId: string): Promise<VerifyPolicy> {
  return rulesVerifyPolicy(toCheckRules(await rules.list(brandId)));
}
