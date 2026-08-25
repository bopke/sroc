import type { Command } from "../types.js";
import { ping } from "./ping.js";
import { systemprompt } from "./systemprompt.js";

export const commands: Command[] = [ping, systemprompt];
