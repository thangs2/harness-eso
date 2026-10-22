#!/usr/bin/env node
/**
 * Thin entry point for the `afterAgentResponse` hook. The detector lives in `lib/agent-response.mjs`
 * so the guard, the `stop` hook and the transcript audit share one definition of "wrapped"; this file
 * only forwards arguments so existing `hooks.json` commands keep working.
 */
import './wrapped-output-guard.mjs';
