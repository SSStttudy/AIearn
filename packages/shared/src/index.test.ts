import { describe, expect, it } from "vitest";
import { learningPlanSchema } from "./index.js";

describe("LearningPlan", () => {
  it("rejects lessons shorter than ten minutes", () => {
    const result = learningPlanSchema.safeParse({title:"x",summary:"x",learnerProfile:"x",duration:"1周",weeklyEffort:"2小时",finalOutcomes:["x"],phases:[{title:"p",goal:"g",lessons:[{title:"l",objectives:["o"],estimatedMinutes:9,completionCriteria:["c"]}]}]});
    expect(result.success).toBe(false);
  });
});
