#!/usr/bin/env bun
import { $ } from "bun";
import { resolveChannel } from "./utils";

const channel = resolveChannel();
await $`bun --cwd ../web build`;
await $`bun ./scripts/copy-icons.ts ${channel}`;
