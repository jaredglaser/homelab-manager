import { z } from 'zod';
import { FINDING_SEVERITIES } from '@/lib/findings/types';
import { zOperatorVerdict, zLabelNote, MAX_MISS_ENTITY_IDS, MAX_MISS_DESCRIPTION_CHARS } from '@/lib/feedback/types';

const MAX_MISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTE_CHARS = 1000;
const MAX_FINDING_IDS = 200;

export const labelFindingSchema = z.object({
  findingId: z.number().int().positive(),
  verdict: zOperatorVerdict,
  note: zLabelNote.optional().default(''),
  duplicateOfId: z.number().int().positive().optional(),
  close: z.boolean().optional(),
});

export const listFindingVerdictsSchema = z.object({
  findingIds: z.array(z.number().int().positive()).max(MAX_FINDING_IDS).default([]),
});

export const reportMissSchema = z
  .object({
    windowFrom: z.coerce.date(),
    windowTo: z.coerce.date(),
    entityIds: z.array(z.string().min(1).max(256)).min(1).max(MAX_MISS_ENTITY_IDS),
    host: z.string().max(255).optional(),
    stackProject: z.string().max(255).optional(),
    whatHappened: z.string().min(1).max(MAX_MISS_DESCRIPTION_CHARS),
    severity: z.enum(FINDING_SEVERITIES),
    note: z.string().max(MAX_NOTE_CHARS).optional().default(''),
  })
  .refine((data) => data.windowFrom.getTime() < data.windowTo.getTime(), {
    error: 'windowFrom must be before windowTo',
    path: ['windowTo'],
  })
  .refine((data) => data.windowTo.getTime() - data.windowFrom.getTime() <= MAX_MISS_WINDOW_MS, {
    error: 'The reported window cannot span more than 7 days',
    path: ['windowTo'],
  });

export const listReportedMissesSchema = z.object({
  status: z.enum(['new', 'attributed', 'accepted', 'explained', 'invalid']).optional(),
  entityId: z.string().max(256).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export const setMissStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['accepted', 'explained', 'invalid']),
  note: z.string().max(MAX_NOTE_CHARS).optional().default(''),
});

export const reattributeMissSchema = z.object({
  id: z.number().int().positive(),
});

export const getFeedbackMetricsSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
