/**
 * 285/T016: Optimizer interface re-export.
 *
 * The `Optimizer` contract lives in `ape/types.ts` (Task 1) alongside the rest
 * of the shared type surface. This module re-exports it so optimizer
 * implementations (OproRewriter) and the loop orchestrator import their
 * interface from the optimizer package, not the root types file.
 */

export type { Optimizer, PromptVariant, EvalSummary } from '../types.js';
