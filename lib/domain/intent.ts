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
  hungerLevel: 0 | 1 | 2 | 3;
  dietary: Dietary[];
  explicit: boolean;
}

export function parseIntent(text: string): ParsedIntent {
  const needs = new Set<Need>();
  for (const [pattern, need] of NEED_PATTERNS) {
    if (pattern.test(text)) needs.add(need);
  }
  const dietary = new Set<Dietary>();
  for (const [pattern, diet] of DIET_PATTERNS) {
    if (pattern.test(text)) dietary.add(diet);
  }
  let hungerLevel: 0 | 1 | 2 | 3 = 0;
  for (const [pattern, level] of HUNGER_PATTERNS) {
    if (pattern.test(text)) {
      hungerLevel = level;
      break;
    }
  }
  return { needs: [...needs], hungerLevel, dietary: [...dietary], explicit: needs.size > 0 || dietary.size > 0 || hungerLevel > 0 };
}

export function mergeCollectiveIntent(
  chatIntent: ParsedIntent,
  saved: CollectiveIntent
): CollectiveIntent {
  const needs = new Set<Need>(saved.need);
  for (const n of chatIntent.needs) needs.add(n);
  const dietary = new Set<Dietary>(saved.dietary);
  for (const d of chatIntent.dietary) dietary.add(d);
  const hungerLevel = Math.max(saved.hungerLevel, chatIntent.hungerLevel) as 0 | 1 | 2 | 3;
  return {
    need: [...needs],
    hungerLevel,
    dietary: [...dietary],
    maxDetourMinutes: saved.maxDetourMinutes,
    kids: saved.kids
  };
}
