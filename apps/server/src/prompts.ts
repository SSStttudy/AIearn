import fs from "node:fs";import path from "node:path";import {config} from "./config.js";
export type PromptName="discovery"|"planner"|"plan-reviser"|"lesson-builder"|"tutor"|"evaluator";
export function prompt(name:PromptName):string{return fs.readFileSync(path.join(config.promptsDir,`${name}.md`),"utf8");}
