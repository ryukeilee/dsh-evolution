import { registerHistoryTool } from './experience-collector.js';

export const name = 'dsh-evolution-experience-history';
export const inject = ['tools', 'evolutionExperience'];
export function apply(ctx) { registerHistoryTool(ctx, ctx.evolutionExperience.store); }
