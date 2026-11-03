import type { CollectiveIntent, Dietary, Need } from "./types";

const NEED_PATTERNS: Array<[RegExp, Need]> = [
  [/ev|electric|charge|charging|battery|supercharg/i, "ev_charge"],
  [/hungry|dinner|lunch|breakfast|meal|eat|food|restaurant/i, "meal"],
  [/coffee|espresso|latte|caffeine|tea\b/i, "coffee"],
  [/washroom|restroom|bathroom|toilet|pee/i, "restroom"],
  [/grocer|snack|supplies|shop|pick up/i, "grocery"]
];

const DIET_PATTERNS: Array<[RegExp, Dietary]> = [
  [/vegan/i, "vegan"],
  [/vegetarian|veggie/i, "vegetarian"],
  [/halal/i, "halal"],
  [/gluten[ -]?free|celiac/i, "gluten_free"]
];

const HUNGER_PATTERNS: Array<[RegExp, 0 | 1 | 2 | 3]> = [
  [/starving|very very hungry|extremely hungry/i, 3],
  [/very hungry|all very hungry|ravenous/i, 3],
  [/hungry/i, 2],
  [/peckish|snackish|light/i, 1]
];

export interface ParsedIntent {
  needs: Need[];
  removeNeeds: Need[];
  hungerLevel: 0 | 1 | 2 | 3;
  dietary: Dietary[];
  clearDietary: boolean;
  resetHunger: boolean;
  corrected: boolean;
  explicit: boolean;
}

const NEGATION = /(no|not|don't need|dont need|skip|without|never)\s+(?:the\s+)?(?:a\s+)?(coffee|meal|dinner|lunch|breakfast|restroom|washroom|bathroom|ev|charge|charging|groceries?)/i;
const CORRECTION = /^(actually|never ?mind|forget it|ignore that|scratch that)[,!\s]*/i;
const NOT_HUNGRY = /(not hungry|full|we ate|already ate|no food|skip (the )?food)/i;
const ALLERGY_CLEAR = /(no dietary|no restrictions|anything is fine|all good on food)/i;

export function parseIntent(text: string): ParsedIntent {
  const lower = text.toLowerCase();
  const corrected = CORRECTION.test(lower);
  const needs = new Set<Need>();
  const removeNeeds = new Set<Need>();
  for (const [pattern, need] of NEED_PATTERNS) {
    if (pattern.test(text)) needs.add(need);
  }
  let m: RegExpExecArray | null;
  const negationRe = new RegExp(NEGATION.source, "gi");
  while ((m = negationRe.exec(lower)) !== null) {
    const word = m[2];
    const mapped = NEED_PATTERNS.find(([p]) => p.test(word))?.[1];
    if (mapped) removeNeeds.add(mapped);
  }
  for (const n of removeNeeds) needs.delete(n);
  const dietary = new Set<Dietary>();
  for (const [pattern, diet] of DIET_PATTERNS) {
    if (pattern.test(text)) dietary.add(diet);
  }
  let hungerLevel: 0 | 1 | 2 | 3 = 0;
  if (corrected || NOT_HUNGRY.test(lower)) {
    hungerLevel = 0;
  } else {
    for (const [pattern, level] of HUNGER_PATTERNS) {
      if (pattern.test(text)) {
        hungerLevel = level;
        break;
      }
    }
  }
  return {
    needs: [...needs],
    removeNeeds: [...removeNeeds],
    hungerLevel,
    dietary: [...dietary],
    clearDietary: ALLERGY_CLEAR.test(lower),
    resetHunger: corrected || NOT_HUNGRY.test(lower),
    corrected,
    explicit: needs.size > 0 || removeNeeds.size > 0 || dietary.size > 0 || hungerLevel > 0 || corrected
  };
}

export function mergeCollectiveIntent(
  chatIntent: ParsedIntent,
  saved: CollectiveIntent
): CollectiveIntent {
  const needs = new Set<Need>(saved.need);
  for (const n of chatIntent.needs) needs.add(n);
  for (const n of chatIntent.removeNeeds) needs.delete(n);
  const dietary = new Set<Dietary>(chatIntent.clearDietary ? [] : saved.dietary);
  for (const d of chatIntent.dietary) dietary.add(d);
  const hungerLevel = (chatIntent.resetHunger ? 0 : Math.max(saved.hungerLevel, chatIntent.hungerLevel)) as 0 | 1 | 2 | 3;
  return {
    need: [...needs],
    hungerLevel,
    dietary: [...dietary],
    maxDetourMinutes: saved.maxDetourMinutes,
    kids: saved.kids
  };
}
